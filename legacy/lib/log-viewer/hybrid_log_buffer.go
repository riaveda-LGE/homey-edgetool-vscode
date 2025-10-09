package logviewer

import (
	"bufio"
	"edgetool/util"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// 4-버퍼 시스템 크기 상수
const (
	RealtimeBufferSize = 1000 // 실시간 로그 버퍼 크기
	ViewportBufferSize = 500  // 뷰포트 캐시 버퍼 크기 (각각)
	SearchResultsSize  = 100  // 검색 결과 버퍼 크기
)

// HybridLogBuffer는 메모리 + 파일 하이브리드 로그 버퍼입니다
type HybridLogBuffer struct {
	mutex  sync.RWMutex
	config LogBufferConfig

	// 4-버퍼 시스템 (검색 버퍼 추가)
	realtimeLogs  []LogEntry // 실시간 로그 (RealtimeBufferSize개)
	viewportLogs1 []LogEntry // 첫 번째 뷰포트 캐시 (ViewportBufferSize개)
	viewportLogs2 []LogEntry // 두 번째 뷰포트 캐시 (ViewportBufferSize개)
	searchResults []LogEntry // 검색 결과 버퍼 (SearchResultsSize개)

	// 뷰포트 범위 관리
	viewport1Range    ViewportRange // 첫 번째 뷰포트 정보
	viewport2Range    ViewportRange // 두 번째 뷰포트 정보
	viewport1LastUsed time.Time     // 첫 번째 뷰포트 최근 사용 시간
	viewport2LastUsed time.Time     // 두 번째 뷰포트 최근 사용 시간
	currentMode       BufferMode    // 현재 사용 중인 버퍼

	// 검색 관리
	currentQuery string // 현재 검색어
	searchMode   bool   // 검색 모드 여부

	// 기존 필드들
	logCounter   int64
	clients      map[string]int64
	subscribers  []chan LogEntry
	fileStorage  *LogFileStorage
	searchIndex  *LogSearchIndex
	totalAdded   int64
	totalFlushed int64
}

// ViewportRange는 뷰포트 캐시의 범위와 상태를 관리합니다
type ViewportRange struct {
	StartID  int64     `json:"start_id"`
	EndID    int64     `json:"end_id"`
	LastUsed time.Time `json:"last_used"`
	IsActive bool      `json:"is_active"`
}

// BufferMode는 현재 사용 중인 버퍼 타입을 나타냅니다
type BufferMode string

const (
	ModeRealtime  BufferMode = "realtime"  // 실시간 버퍼 사용
	ModeViewport1 BufferMode = "viewport1" // 첫 번째 뷰포트 버퍼 사용
	ModeViewport2 BufferMode = "viewport2" // 두 번째 뷰포트 버퍼 사용
	ModeSearch    BufferMode = "search"    // 검색 모드
)

// Contains는 뷰포트 범위가 지정된 로그 ID 범위를 포함하는지 확인합니다
func (vr *ViewportRange) Contains(startID, endID int64) bool {
	return vr.IsActive && startID >= vr.StartID && endID <= vr.EndID
}

// LogFileStorage는 로그 파일 저장 및 관리를 담당합니다
type LogFileStorage struct {
	logsDir     string
	currentFile string
	currentSize int64
	maxFileSize int64
	fileIndex   map[string]*LogFileInfo // filename -> file info
	mutex       sync.RWMutex
}

// LogFileInfo는 개별 로그 파일의 정보를 저장합니다
type LogFileInfo struct {
	Filename     string    `json:"filename"`
	StartLogID   int64     `json:"start_log_id"`
	EndLogID     int64     `json:"end_log_id"`
	LogCount     int       `json:"log_count"`
	FileSize     int64     `json:"file_size"`
	CreatedAt    time.Time `json:"created_at"`
	LastModified time.Time `json:"last_modified"`
}

// LogSearchIndex는 빠른 로그 검색을 위한 인덱스입니다
type LogSearchIndex struct {
	indexFile string
	index     map[string]*LogFileInfo // filename -> file info (파일별 인덱스)
	mutex     sync.RWMutex
}

// NewHybridLogBuffer는 새로운 HybridLogBuffer를 생성합니다
func NewHybridLogBuffer(config LogBufferConfig) *HybridLogBuffer {
	// logs 디렉토리 생성 (상위 디렉토리)
	logsDir := filepath.Dir(config.LogsDirectory)
	if err := os.MkdirAll(logsDir, 0755); err != nil {
		util.Log(util.ColorRed, "❌ [HybridLogBuffer] logs 디렉토리 생성 실패: %v\n", err)
		return nil
	}

	// raw 디렉토리 초기화 (기존 파일들 모두 삭제 후 새로 생성)
	rawDir := filepath.Join(config.LogsDirectory, "raw")
	if err := cleanAndCreateRawDirectory(rawDir); err != nil {
		util.Log(util.ColorRed, "❌ [HybridLogBuffer] raw 디렉토리 초기화 실패: %v\n", err)
		return nil
	}

	// 파일 저장소 초기화
	fileStorage := &LogFileStorage{
		logsDir:     rawDir, // raw 디렉토리 사용
		maxFileSize: config.FileMaxSize,
		fileIndex:   make(map[string]*LogFileInfo),
	}

	// 검색 인덱스 초기화
	searchIndex := &LogSearchIndex{
		indexFile: filepath.Join(config.LogsDirectory, "index.json"),
		index:     make(map[string]*LogFileInfo),
	}

	buffer := &HybridLogBuffer{
		config:            config,
		realtimeLogs:      make([]LogEntry, 0),
		viewportLogs1:     make([]LogEntry, 0),
		viewportLogs2:     make([]LogEntry, 0),
		searchResults:     make([]LogEntry, 0),
		viewport1Range:    ViewportRange{},
		viewport2Range:    ViewportRange{},
		viewport1LastUsed: time.Now(),
		viewport2LastUsed: time.Now(),
		currentMode:       ModeRealtime,
		currentQuery:      "",
		searchMode:        false,
		clients:           make(map[string]int64),
		subscribers:       make([]chan LogEntry, 0),
		fileStorage:       fileStorage,
		searchIndex:       searchIndex,
	}

	// 기존 파일들과 인덱스 로드
	buffer.loadExistingFiles()

	util.Log(util.ColorGreen, "✅ [HybridLogBuffer] 초기화 완료 (메모리: %d, 디렉토리: %s)\n",
		config.MaxMemorySize, config.LogsDirectory)

	return buffer
}

// AddLog는 새 로그를 버퍼에 추가합니다
func (hb *HybridLogBuffer) AddLog(entry LogEntry) {
	hb.mutex.Lock()
	defer hb.mutex.Unlock()

	// 로그에 유니크 ID 부여
	hb.logCounter++
	hb.totalAdded++
	entry.ID = hb.logCounter

	// Index가 설정되어 있지 않으면 logCounter를 사용 (스크롤용 순서 인덱스)
	if entry.Index == 0 {
		entry.Index = int(hb.logCounter)
	}

	// 메모리 버퍼에 추가
	hb.realtimeLogs = append(hb.realtimeLogs, entry)

	// 메모리 버퍼 크기 초과 시 오래된 로그들을 파일로 플러시
	if len(hb.realtimeLogs) > hb.config.MaxMemorySize {
		hb.flushOldLogsToFile()
	}

	// 모든 구독자에게 실시간 알림
	for _, ch := range hb.subscribers {
		select {
		case ch <- entry:
		default:
			// 채널이 블록되면 스킵
		}
	}
}

// Subscribe는 새 클라이언트를 등록하고 실시간 알림 채널을 반환합니다
func (hb *HybridLogBuffer) Subscribe(clientID string) chan LogEntry {
	hb.mutex.Lock()
	defer hb.mutex.Unlock()

	// 클라이언트 등록
	hb.clients[clientID] = hb.logCounter

	// 실시간 알림용 채널 생성
	ch := make(chan LogEntry, DefaultSubscriberSize)
	hb.subscribers = append(hb.subscribers, ch)

	util.Log(util.ColorGreen, "✅ [HybridLogBuffer] 클라이언트 구독 등록: %s\n", clientID)

	return ch
}

// Unsubscribe는 클라이언트를 해제합니다
func (hb *HybridLogBuffer) Unsubscribe(clientID string, ch chan LogEntry) {
	hb.mutex.Lock()
	defer hb.mutex.Unlock()

	delete(hb.clients, clientID)

	// 채널 제거
	for i, subscriber := range hb.subscribers {
		if subscriber == ch {
			hb.subscribers = append(hb.subscribers[:i], hb.subscribers[i+1:]...)
			// 이미 닫힌 채널을 닫으려고 하면 panic이 발생할 수 있으므로 recover 사용
			defer func() {
				if r := recover(); r != nil {
					// 채널이 이미 닫혀있음 - 무시
				}
			}()
			close(ch)
			break
		}
	}

	util.Log(util.ColorYellow, "⚠️ [HybridLogBuffer] 클라이언트 구독 해제: %s\n", clientID)
}

// GetNewLogs는 클라이언트의 새 로그들을 반환합니다 (메모리 + 필요시 파일에서 로드)
func (hb *HybridLogBuffer) GetNewLogs(clientID string) []LogEntry {
	hb.mutex.RLock()
	defer hb.mutex.RUnlock()

	lastConsumed, exists := hb.clients[clientID]
	if !exists {
		// 새 클라이언트면 메모리의 모든 로그 반환 (파일 로그는 필요시 별도 요청)
		return append([]LogEntry{}, hb.realtimeLogs...)
	}

	// 메모리에서 새 로그들 찾기
	newLogs := make([]LogEntry, 0)
	for _, log := range hb.realtimeLogs {
		if log.ID > lastConsumed {
			newLogs = append(newLogs, log)
		}
	}

	return newLogs
}

// GetRawDirectory는 raw 디렉토리 경로를 반환합니다
func (hb *HybridLogBuffer) GetRawDirectory() string {
	if hb.fileStorage != nil {
		return hb.fileStorage.logsDir
	}
	return ""
}

// GetAllLogs는 모든 로그를 반환합니다 (메모리 + 파일)
func (hb *HybridLogBuffer) GetAllLogs() []LogEntry {
	hb.mutex.RLock()
	defer hb.mutex.RUnlock()

	allLogs := make([]LogEntry, 0)

	// 1. 파일에서 모든 로그 로드
	if hb.fileStorage != nil {
		fileLogs, err := hb.fileStorage.loadLogsInRange(1, hb.logCounter)
		if err != nil {
			util.Log(util.ColorRed, "❌ [HybridLogBuffer] 파일 로그 로드 실패: %v\n", err)
		} else {
			allLogs = append(allLogs, fileLogs...)
		}
	}

	// 2. 메모리 로그 추가
	allLogs = append(allLogs, hb.realtimeLogs...)

	// 3. ID 순으로 정렬
	sort.Slice(allLogs, func(i, j int) bool {
		return allLogs[i].ID < allLogs[j].ID
	})

	util.Log(util.ColorGreen, "📊 [HybridLogBuffer] 모든 로그 조회: %d개\n", len(allLogs))
	return allLogs
}

// GetLogsInRange는 지정된 범위의 로그들을 반환합니다 (메모리 + 파일 조합)
func (hb *HybridLogBuffer) GetLogsInRange(startID, endID int64) []LogEntry {
	hb.mutex.RLock()
	defer hb.mutex.RUnlock()

	util.Log(util.ColorGreen, "🔍 [HybridLogBuffer] 범위 로그 요청: %d~%d\n", startID, endID)

	if startID > endID {
		return []LogEntry{}
	}

	allLogs := make([]LogEntry, 0)

	// 1. 파일에서 해당 범위 로그 찾기
	fileLogs, err := hb.fileStorage.loadLogsInRange(startID, endID)
	if err != nil {
		util.Log(util.ColorRed, "❌ [HybridLogBuffer] 파일 로그 로드 실패: %v\n", err)
	} else {
		allLogs = append(allLogs, fileLogs...)
		util.Log(util.ColorCyan, "📁 [HybridLogBuffer] 파일에서 %d개 로그 로드 (범위: %d~%d)\n", len(fileLogs), startID, endID)
	}

	// 2. 메모리에서 해당 범위 로그 찾기
	for _, log := range hb.realtimeLogs {
		if log.ID >= startID && log.ID <= endID {
			allLogs = append(allLogs, log)
		}
	}

	// 3. ID 순으로 정렬
	sort.Slice(allLogs, func(i, j int) bool {
		return allLogs[i].ID < allLogs[j].ID
	})

	util.Log(util.ColorCyan, "📋 [HybridLogBuffer] 범위 로그 조회: %d~%d (%d개 반환)\n",
		startID, endID, len(allLogs))

	return allLogs
}

// GetLogsByScrollPosition은 스크롤 위치에 따라 로그를 반환하며 뷰포트 캐시를 관리합니다
func (hb *HybridLogBuffer) GetLogsByScrollPosition(scrollTop float64, viewportHeight float64, totalHeight float64) []LogEntry {
	hb.mutex.Lock()
	defer hb.mutex.Unlock()

	// 스크롤 비율 계산 (0.0 ~ 1.0)
	scrollRatio := 0.0
	if totalHeight > viewportHeight {
		scrollRatio = scrollTop / (totalHeight - viewportHeight)
	}

	// 전체 로그 수 계산
	totalCount := hb.getTotalLogCount()
	if totalCount == 0 {
		return []LogEntry{}
	}

	// 요청된 범위 계산
	startIndex := int64(float64(totalCount) * scrollRatio)
	endIndex := startIndex + int64(hb.config.ViewportSize)
	if endIndex > totalCount {
		endIndex = totalCount
	}

	requestedRange := ViewportRange{
		StartID: startIndex + 1, // ID는 1부터 시작
		EndID:   endIndex,
	}

	util.Log(util.ColorCyan, "📜 [HybridLogBuffer] 스크롤 요청: %.2f%% (%d~%d), 총:%d\n", scrollRatio*100, requestedRange.StartID, requestedRange.EndID, totalCount)

	// 1. 실시간 버퍼 확인 (최신 로그들)
	realtimeStartID := totalCount - int64(len(hb.realtimeLogs)) + 1
	if realtimeStartID < 1 {
		realtimeStartID = 1
	}
	realtimeRange := ViewportRange{
		StartID:  realtimeStartID,
		EndID:    totalCount,
		IsActive: true,
	}

	if realtimeRange.Contains(requestedRange.StartID, requestedRange.EndID) {
		util.Log(util.ColorGreen, "⚡ [HybridLogBuffer] 메모리 버퍼 히트: %d~%d\n", requestedRange.StartID, requestedRange.EndID)
		hb.currentMode = ModeRealtime
		return hb.getLogsFromRealtimeBuffer(requestedRange)
	}

	// 2. 뷰포트 캐시 확인
	if hb.viewport1Range.Contains(requestedRange.StartID, requestedRange.EndID) {
		util.Log(util.ColorGreen, "🎯 [HybridLogBuffer] 파일 캐시 히트 (뷰포트1): %d~%d\n", requestedRange.StartID, requestedRange.EndID)
		hb.currentMode = ModeViewport1
		hb.updateViewportUsage(1) // LRU 업데이트
		return hb.getLogsFromViewportBuffer(1, requestedRange)
	}

	if hb.viewport2Range.Contains(requestedRange.StartID, requestedRange.EndID) {
		util.Log(util.ColorGreen, "🎯 [HybridLogBuffer] 파일 캐시 히트 (뷰포트2): %d~%d\n", requestedRange.StartID, requestedRange.EndID)
		hb.currentMode = ModeViewport2
		hb.updateViewportUsage(2) // LRU 업데이트
		return hb.getLogsFromViewportBuffer(2, requestedRange)
	}

	// 3. 캐시 미스 - 새로운 뷰포트 로드
	util.Log(util.ColorYellow, "💾 [HybridLogBuffer] 캐시 미스 - 파일 로드: %d~%d\n", requestedRange.StartID, requestedRange.EndID)
	logs := hb.GetLogsInRange(requestedRange.StartID, requestedRange.EndID)

	// LRU 방식으로 뷰포트 교체
	targetViewport := hb.selectLRUViewport()
	hb.loadViewportCache(targetViewport, requestedRange, logs)

	if targetViewport == 1 {
		hb.currentMode = ModeViewport1
	} else {
		hb.currentMode = ModeViewport2
	}

	return logs
}

// getTotalLogCount는 전체 로그 수를 반환합니다
func (hb *HybridLogBuffer) getTotalLogCount() int64 {
	// 파일에 저장된 로그 수 + 메모리 로그 수
	return hb.totalFlushed + int64(len(hb.realtimeLogs))
}

// getFirstLogID는 첫 번째 로그 ID를 반환합니다
func (hb *HybridLogBuffer) getFirstLogID() int64 {
	// 현재 로그 카운터에서 전체 로그 수를 빼면 첫 번째 로그 ID
	totalLogs := hb.getTotalLogCount()
	if totalLogs == 0 {
		return 1
	}
	return hb.logCounter - totalLogs + 1
}

// MarkConsumed는 클라이언트가 특정 로그까지 소비했음을 마킹합니다
func (hb *HybridLogBuffer) MarkConsumed(clientID string, logID int64) {
	hb.mutex.Lock()
	defer hb.mutex.Unlock()

	if currentPos, exists := hb.clients[clientID]; exists && logID > currentPos {
		hb.clients[clientID] = logID
	}
}

// GetStats는 버퍼 통계를 반환합니다
func (hb *HybridLogBuffer) GetStats() map[string]interface{} {
	hb.mutex.RLock()
	defer hb.mutex.RUnlock()

	stats := map[string]interface{}{
		"type":            "hybrid",
		"realtime_logs":   len(hb.realtimeLogs),
		"viewport1_logs":  len(hb.viewportLogs1),
		"viewport2_logs":  len(hb.viewportLogs2),
		"search_results":  len(hb.searchResults),
		"total_clients":   len(hb.clients),
		"max_memory_size": hb.config.MaxMemorySize,
		"viewport_size":   hb.config.ViewportSize,
		"log_counter":     hb.logCounter,
		"total_added":     hb.totalAdded,
		"total_flushed":   hb.totalFlushed,
		"total_logs":      hb.getTotalLogCount(),
		"logs_directory":  hb.config.LogsDirectory,
		"current_mode":    hb.currentMode,
		"search_mode":     hb.searchMode,
		"current_query":   hb.currentQuery,
		"clients":         make(map[string]int64),
	}

	// 클라이언트별 소비 위치 복사
	for clientID, pos := range hb.clients {
		stats["clients"].(map[string]int64)[clientID] = pos
	}

	return stats
}

// Cleanup은 정리 작업을 수행합니다
func (hb *HybridLogBuffer) Cleanup() {
	hb.mutex.Lock()
	defer hb.mutex.Unlock()

	// 필요시 파일 정리 작업 수행
	// (현재는 메모리 로그만 정리)
}

// Close는 HybridLogBuffer를 종료합니다
func (hb *HybridLogBuffer) Close() {
	hb.mutex.Lock()
	defer hb.mutex.Unlock()

	// 남은 메모리 로그들을 파일로 플러시
	if len(hb.realtimeLogs) > 0 {
		hb.flushOldLogsToFile()
	}

	// 구독자 채널 닫기
	for _, ch := range hb.subscribers {
		close(ch)
	}

	// 인덱스 저장
	hb.searchIndex.save()

	util.Log(util.ColorGreen, "✅ [HybridLogBuffer] 종료 완료\n")
}

// flushOldLogsToFile은 오래된 메모리 로그들을 파일로 저장합니다
func (hb *HybridLogBuffer) flushOldLogsToFile() {
	if len(hb.realtimeLogs) <= hb.config.MaxMemorySize/2 {
		return
	}

	// 절반 정도를 파일로 저장
	flushCount := len(hb.realtimeLogs) - hb.config.MaxMemorySize/2
	logsToFlush := hb.realtimeLogs[:flushCount]

	// 파일로 저장
	if err := hb.fileStorage.saveLogs(logsToFlush); err != nil {
		util.Log(util.ColorRed, "❌ [HybridLogBuffer] 파일 저장 실패: %v\n", err)
		return
	}

	// 메모리에서 제거
	hb.realtimeLogs = hb.realtimeLogs[flushCount:]
	hb.totalFlushed += int64(flushCount)

	// 인덱스 업데이트
	for _, log := range logsToFlush {
		hb.searchIndex.addLog(log, hb.fileStorage.currentFile)
	}

	util.Log(util.ColorCyan, "💾 [HybridLogBuffer] %d개 로그를 파일로 저장\n", flushCount)
}

// loadExistingFiles는 기존 파일들을 로드하고 인덱스를 구축합니다
func (hb *HybridLogBuffer) loadExistingFiles() {
	// 기존 인덱스 파일 로드 (있다면)
	hb.searchIndex.load()

	// raw 디렉토리는 초기화되었으므로 빈 상태로 시작
	// 새로운 세션에서는 기존 파일을 로드하지 않음
	util.Log(util.ColorGreen, "✅ [HybridLogBuffer] 새로운 세션 시작 - 깨끗한 raw 디렉토리로 시작\n")
}

// cleanAndCreateRawDirectory는 raw 디렉토리를 깨끗하게 초기화합니다
func cleanAndCreateRawDirectory(rawDir string) error {
	// raw 디렉토리가 존재하는지 확인
	if _, err := os.Stat(rawDir); err == nil {
		// 디렉토리가 존재하면 내용물 확인
		entries, err := os.ReadDir(rawDir)
		if err != nil {
			return fmt.Errorf("raw 디렉토리 읽기 실패: %v", err)
		}

		// 디렉토리가 비어있으면 이미 초기화된 것으로 간주, 스킵
		if len(entries) == 0 {
			return nil
		}

		// 비어있지 않으면 삭제
		if err := os.RemoveAll(rawDir); err != nil {
			return fmt.Errorf("raw 디렉토리 삭제 실패: %v", err)
		}
		util.Log(util.ColorYellow, "🧹 [HybridLogBuffer] 기존 raw 디렉토리 삭제됨: %s\n", rawDir)
	}

	// raw 디렉토리 새로 생성
	if err := os.MkdirAll(rawDir, 0755); err != nil {
		return fmt.Errorf("raw 디렉토리 생성 실패: %v", err)
	}

	util.Log(util.ColorGreen, "✅ [HybridLogBuffer] 새로운 raw 디렉토리 생성됨: %s\n", rawDir)
	return nil
}

// rangeContains는 parentRange가 childRange를 포함하는지 확인합니다
func (hb *HybridLogBuffer) rangeContains(parentRange, childRange ViewportRange) bool {
	return parentRange.StartID <= childRange.StartID && parentRange.EndID >= childRange.EndID
}

// getLogsFromRealtimeBuffer는 실시간 버퍼에서 로그를 가져옵니다
func (hb *HybridLogBuffer) getLogsFromRealtimeBuffer(requestedRange ViewportRange) []LogEntry {
	result := make([]LogEntry, 0)
	for _, log := range hb.realtimeLogs {
		if log.ID >= requestedRange.StartID && log.ID <= requestedRange.EndID {
			result = append(result, log)
		}
	}
	return result
}

// getLogsFromViewportBuffer는 뷰포트 버퍼에서 로그를 가져옵니다
func (hb *HybridLogBuffer) getLogsFromViewportBuffer(viewportNum int, requestedRange ViewportRange) []LogEntry {
	var logs []LogEntry
	if viewportNum == 1 {
		logs = hb.viewportLogs1
	} else {
		logs = hb.viewportLogs2
	}

	result := make([]LogEntry, 0)
	for _, log := range logs {
		if log.ID >= requestedRange.StartID && log.ID <= requestedRange.EndID {
			result = append(result, log)
		}
	}
	return result
}

// selectLRUViewport는 LRU 방식으로 교체할 뷰포트를 선택합니다
func (hb *HybridLogBuffer) selectLRUViewport() int {
	// 빈 뷰포트가 있으면 우선 사용
	if len(hb.viewportLogs1) == 0 {
		return 1
	}
	if len(hb.viewportLogs2) == 0 {
		return 2
	}

	// 둘 다 사용 중이면 LRU 기준으로 선택
	if hb.viewport1LastUsed.Before(hb.viewport2LastUsed) {
		return 1
	}
	return 2
}

// loadViewportCache는 뷰포트 캐시를 로드합니다
func (hb *HybridLogBuffer) loadViewportCache(viewportNum int, rangeInfo ViewportRange, logs []LogEntry) {
	if viewportNum == 1 {
		hb.viewportLogs1 = logs
		hb.viewport1Range = rangeInfo
		hb.viewport1LastUsed = time.Now()
	} else {
		hb.viewportLogs2 = logs
		hb.viewport2Range = rangeInfo
		hb.viewport2LastUsed = time.Now()
	}
}

// updateViewportUsage는 뷰포트 사용 시간을 업데이트합니다
func (hb *HybridLogBuffer) updateViewportUsage(viewportNum int) {
	if viewportNum == 1 {
		hb.viewport1LastUsed = time.Now()
	} else {
		hb.viewport2LastUsed = time.Now()
	}
}

// Search는 키워드를 검색하고 결과를 searchResults 버퍼에 저장합니다
func (hb *HybridLogBuffer) Search(keyword string) []LogEntry {
	hb.mutex.Lock()
	defer hb.mutex.Unlock()

	// 1. 검색 버퍼 초기화 (새 검색시마다)
	hb.searchResults = make([]LogEntry, 0, SearchResultsSize)
	hb.currentQuery = keyword
	hb.searchMode = true
	hb.currentMode = ModeSearch

	if keyword == "" {
		return hb.searchResults
	}

	lowerKeyword := strings.ToLower(keyword)
	matchCount := 0
	maxResults := SearchResultsSize

	// 2. 실시간 버퍼에서 검색
	for _, log := range hb.realtimeLogs {
		if matchCount >= maxResults {
			break
		}
		if strings.Contains(strings.ToLower(log.Message), lowerKeyword) {
			hb.searchResults = append(hb.searchResults, log)
			matchCount++
		}
	}

	// 3. 모든 파일에서 검색 (부족한 경우)
	if matchCount < maxResults {
		fileResults := hb.searchInAllFiles(lowerKeyword, maxResults-matchCount)
		hb.searchResults = append(hb.searchResults, fileResults...)
	}

	// 4. 시간순 정렬 (최신 로그가 위로)
	sort.Slice(hb.searchResults, func(i, j int) bool {
		return hb.searchResults[i].ID > hb.searchResults[j].ID
	})

	util.Log(util.ColorCyan, "🔍 [HybridLogBuffer] 검색 완료: '%s' (%d개 발견)\n", keyword, len(hb.searchResults))

	return hb.searchResults
}

// searchInAllFiles는 모든 파일에서 키워드를 검색합니다
func (hb *HybridLogBuffer) searchInAllFiles(keyword string, limit int) []LogEntry {
	results := make([]LogEntry, 0, limit)
	matchCount := 0

	// 모든 파일을 순회하며 검색
	for filename := range hb.fileStorage.fileIndex {
		if matchCount >= limit {
			break
		}

		filePath := filepath.Join(hb.config.LogsDirectory, filename)
		file, err := os.Open(filePath)
		if err != nil {
			util.Log(util.ColorRed, "❌ [HybridLogBuffer] 파일 열기 실패: %s\n", filename)
			continue
		}

		scanner := bufio.NewScanner(file)
		for scanner.Scan() && matchCount < limit {
			var entry LogEntry
			if json.Unmarshal(scanner.Bytes(), &entry) == nil {
				if strings.Contains(strings.ToLower(entry.Message), keyword) {
					results = append(results, entry)
					matchCount++
				}
			}
		}
		file.Close()
	}

	return results
}

// ExitSearchMode는 검색 모드를 종료합니다
func (hb *HybridLogBuffer) ExitSearchMode() {
	hb.mutex.Lock()
	defer hb.mutex.Unlock()

	hb.searchMode = false
	hb.currentQuery = ""
	hb.searchResults = nil
	hb.currentMode = ModeRealtime

	util.Log(util.ColorGreen, "✅ [HybridLogBuffer] 검색 모드 종료\n")
}

// IsSearchMode는 현재 검색 모드인지 확인합니다
func (hb *HybridLogBuffer) IsSearchMode() bool {
	hb.mutex.RLock()
	defer hb.mutex.RUnlock()
	return hb.searchMode
}

// GetSearchResults는 현재 검색 결과를 반환합니다
func (hb *HybridLogBuffer) GetSearchResults() []LogEntry {
	hb.mutex.RLock()
	defer hb.mutex.RUnlock()

	if !hb.searchMode {
		return []LogEntry{}
	}

	return append([]LogEntry{}, hb.searchResults...)
}

// syncIndex는 파일 저장소의 정보를 검색 인덱스에 동기화합니다
func (hb *HybridLogBuffer) syncIndex() {
	if hb.fileStorage == nil || hb.searchIndex == nil {
		return
	}

	hb.mutex.RLock()
	defer hb.mutex.RUnlock()

	// 파일 저장소의 모든 파일 정보를 검색 인덱스에 복사
	hb.fileStorage.mutex.RLock()
	for filename, fileInfo := range hb.fileStorage.fileIndex {
		hb.searchIndex.index[filename] = fileInfo
	}
	hb.fileStorage.mutex.RUnlock()

	// 인덱스 저장
	if err := hb.searchIndex.save(); err != nil {
		util.Log(util.ColorRed, "❌ [HybridLogBuffer] 인덱스 저장 실패: %v\n", err)
	}
}
