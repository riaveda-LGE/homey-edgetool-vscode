package logviewer

import (
	"edgetool/util"
	"strings"
	"sync"
)

// LogBuffer 관련 상수들
const (
	DefaultMaxSize        = 500   // 기본 최대 로그 버퍼 크기
	DefaultSubscriberSize = 10000 // 구독자 채널 버퍼 크기 (대량 로그 대응)
)

// MemoryLogBuffer는 메모리 기반 로그 버퍼로 클라이언트 수집 후 자동 정리를 지원합니다
type MemoryLogBuffer struct {
	mutex       sync.RWMutex
	logs        []LogEntry
	maxSize     int
	clients     map[string]int64 // client ID -> last consumed log ID
	subscribers []chan LogEntry  // 실시간 알림용 채널들
	logCounter  int64            // 각 로그에 유니크 ID 부여
	// 디버깅용 통계
	totalAdded   int64 // 총 추가된 로그 수
	totalRemoved int64 // 총 제거된 로그 수
}

// NewMemoryLogBuffer는 새로운 MemoryLogBuffer를 생성합니다
func NewMemoryLogBuffer(maxSize int) *MemoryLogBuffer {
	return &MemoryLogBuffer{
		logs:         make([]LogEntry, 0),
		maxSize:      maxSize,
		clients:      make(map[string]int64),
		subscribers:  make([]chan LogEntry, 0),
		logCounter:   0,
		totalAdded:   0,
		totalRemoved: 0,
	}
}

// AddLog는 새 로그를 버퍼에 추가하고 구독자들에게 알립니다
func (lb *MemoryLogBuffer) AddLog(entry LogEntry) {
	lb.mutex.Lock()
	defer lb.mutex.Unlock()

	// 로그에 유니크 ID 부여
	lb.logCounter++
	lb.totalAdded++
	entry.ID = lb.logCounter

	// Index가 설정되어 있지 않으면 logCounter를 사용 (스크롤용 순서 인덱스)
	if entry.Index == 0 {
		entry.Index = int(lb.logCounter)
	}

	// 버퍼에 추가
	lb.logs = append(lb.logs, entry)

	// 최대 크기 초과 시 오래된 로그 제거 (단, 모든 클라이언트가 소비한 것만)
	if len(lb.logs) > lb.maxSize {
		lb.cleanupInternal()
	}

	// 모든 구독자에게 실시간 알림
	for _, ch := range lb.subscribers {
		select {
		case ch <- entry:
		default:
			// 채널이 블록되면 스킵 (클라이언트가 느림)
			util.Log(util.ColorYellow, "⚠️ [LogBuffer] 채널 블록됨 - 로그 ID %d 스킵\n", entry.ID)
		}
	}
}

// AddLogsBatch는 여러 로그를 배치로 추가합니다 (성능 최적화)
func (lb *MemoryLogBuffer) AddLogsBatch(entries []LogEntry) {
	if len(entries) == 0 {
		return
	}

	lb.mutex.Lock()
	defer lb.mutex.Unlock()

	// 배치로 로그 추가
	for i := range entries {
		lb.logCounter++
		lb.totalAdded++
		entries[i].ID = lb.logCounter

		// Index가 설정되어 있지 않으면 logCounter를 사용 (스크롤용 순서 인덱스)
		if entries[i].Index == 0 {
			entries[i].Index = int(lb.logCounter)
		}

		lb.logs = append(lb.logs, entries[i])
	}

	// 최대 크기 초과 시 정리
	if len(lb.logs) > lb.maxSize {
		lb.cleanupInternal()
	}

	// 배치 알림 (성능 향상)
	for _, ch := range lb.subscribers {
		for _, entry := range entries {
			select {
			case ch <- entry:
			default:
				// 배치 중 블록되면 해당 로그부터 스킵
				util.Log(util.ColorYellow, "⚠️ [LogBuffer] 배치 채널 블록됨 - 로그 ID %d부터 스킵\n", entry.ID)
				goto NextSubscriber
			}
		}
	NextSubscriber:
	}
}

// Subscribe는 새 클라이언트를 등록하고 실시간 알림 채널을 반환합니다
func (lb *MemoryLogBuffer) Subscribe(clientID string) chan LogEntry {
	lb.mutex.Lock()
	defer lb.mutex.Unlock()

	// clients map이 nil인 경우 초기화
	if lb.clients == nil {
		lb.clients = make(map[string]int64)
		util.Log(util.ColorYellow, "⚠️ [LogBuffer] clients map 초기화됨\n")
	}

	// 클라이언트 등록 (마지막 소비 위치를 현재 로그 카운터로 설정)
	lb.clients[clientID] = lb.logCounter

	// 실시간 알림용 채널 생성
	ch := make(chan LogEntry, DefaultSubscriberSize) // 버퍼 크기 상수 사용
	lb.subscribers = append(lb.subscribers, ch)

	util.Log(util.ColorGreen, "✅ [LogBuffer] 클라이언트 구독 등록: %s (총 %d개 클라이언트)\n", clientID, len(lb.clients))

	return ch
}

// Unsubscribe는 클라이언트를 해제하고 채널을 정리합니다
func (lb *MemoryLogBuffer) Unsubscribe(clientID string, ch chan LogEntry) {
	lb.mutex.Lock()
	defer lb.mutex.Unlock()

	// 클라이언트 제거
	delete(lb.clients, clientID)

	// 채널 제거
	for i, subscriber := range lb.subscribers {
		if subscriber == ch {
			// 슬라이스에서 제거
			lb.subscribers = append(lb.subscribers[:i], lb.subscribers[i+1:]...)
			close(ch)
			break
		}
	}

	util.Log(util.ColorYellow, "⚠️ [LogBuffer] 클라이언트 구독 해제: %s (남은 %d개 클라이언트)\n", clientID, len(lb.clients))

	// 정리 작업 수행
	lb.cleanupInternal()
}

// GetNewLogs는 특정 클라이언트의 새 로그들을 반환합니다
func (lb *MemoryLogBuffer) GetNewLogs(clientID string) []LogEntry {
	lb.mutex.RLock()
	defer lb.mutex.RUnlock()

	lastConsumed, exists := lb.clients[clientID]
	if !exists {
		// 새 클라이언트면 모든 로그 반환
		return append([]LogEntry{}, lb.logs...)
	}

	// 마지막 소비 이후의 로그들만 반환
	newLogs := make([]LogEntry, 0)
	for _, log := range lb.logs {
		if log.ID > lastConsumed {
			newLogs = append(newLogs, log)
		}
	}

	return newLogs
}

// MarkConsumed는 클라이언트가 특정 로그까지 소비했음을 마킹합니다
func (lb *MemoryLogBuffer) MarkConsumed(clientID string, logID int64) {
	lb.mutex.Lock()
	defer lb.mutex.Unlock()

	if currentPos, exists := lb.clients[clientID]; exists && logID > currentPos {
		lb.clients[clientID] = logID

		// 정리 작업 수행
		lb.cleanupInternal()
	}
}

// cleanupInternal은 모든 클라이언트가 소비한 로그들을 버퍼에서 제거합니다 (내부 호출용)
func (lb *MemoryLogBuffer) cleanupInternal() int64 {
	if len(lb.clients) == 0 {
		// 클라이언트가 없으면 모든 로그 제거
		removedCount := int64(len(lb.logs))
		lb.logs = lb.logs[:0]
		lb.totalRemoved += removedCount
		if removedCount >= 10 { // 대량 정리 시에만 로그 출력
			util.Log(util.ColorYellow, "🧹 [LogBuffer] 클라이언트 없음 - 대량 로그 정리 (%d개)\n", removedCount)
		}
		return removedCount
	}

	// 모든 클라이언트가 소비한 최소 위치 찾기
	minConsumed := lb.logCounter + 1 // 초기값을 매우 큰 값으로 설정
	for _, consumed := range lb.clients {
		if consumed < minConsumed {
			minConsumed = consumed
		}
	}

	// 모든 클라이언트가 소비한 로그들 제거
	originalCount := len(lb.logs)
	newLogs := make([]LogEntry, 0)
	for _, log := range lb.logs {
		if log.ID > minConsumed {
			newLogs = append(newLogs, log)
		}
	}

	lb.logs = newLogs
	removedCount := int64(originalCount - len(lb.logs))
	lb.totalRemoved += removedCount

	if removedCount >= 10 { // 대량 정리 시에만 로그 출력 (임계값: 10개 이상)
		util.Log(util.ColorGreen, "🧹 [LogBuffer] 대량 로그 정리됨 (%d개, 남은 %d개)\n", removedCount, len(lb.logs))
	}

	return removedCount
}

// Cleanup은 외부에서 호출할 수 있는 정리 함수입니다
func (lb *MemoryLogBuffer) Cleanup() {
	lb.mutex.Lock()
	defer lb.mutex.Unlock()
	lb.cleanupInternal()
}

// Close는 MemoryLogBuffer를 종료하고 모든 리소스를 정리합니다
func (lb *MemoryLogBuffer) Close() {
	lb.mutex.Lock()
	defer lb.mutex.Unlock()

	// 모든 구독자 채널 닫기
	for _, ch := range lb.subscribers {
		close(ch)
	}

	// 모든 데이터 정리
	lb.logs = nil
	lb.clients = nil
	lb.subscribers = nil

	util.Log(util.ColorGreen, "✅ [MemoryLogBuffer] 종료 및 리소스 정리 완료\n")
}

// GetLogsInRange는 지정된 범위의 로그들을 반환합니다 (메모리 전용)
func (lb *MemoryLogBuffer) GetLogsInRange(startID, endID int64) []LogEntry {
	lb.mutex.RLock()
	defer lb.mutex.RUnlock()

	logs := make([]LogEntry, 0)
	for _, log := range lb.logs {
		if log.ID >= startID && log.ID <= endID {
			logs = append(logs, log)
		}
	}

	return logs
}

// GetLogsByScrollPosition은 스크롤 위치 기반으로 로그를 반환합니다 (메모리 전용)
func (lb *MemoryLogBuffer) GetLogsByScrollPosition(scrollTop float64, viewportHeight float64, totalHeight float64) []LogEntry {
	lb.mutex.RLock()
	defer lb.mutex.RUnlock()

	// 스크롤 비율 계산 (0.0 ~ 1.0)
	scrollRatio := 0.0
	if totalHeight > viewportHeight {
		scrollRatio = scrollTop / (totalHeight - viewportHeight)
	}

	totalLogs := len(lb.logs)
	if totalLogs == 0 || scrollRatio < 0 || scrollRatio > 1 {
		return []LogEntry{}
	}

	// 기본 뷰포트 크기 (메모리 버퍼는 500개 고정)
	viewportSize := 500
	startIndex := int(float64(totalLogs) * scrollRatio)
	endIndex := startIndex + viewportSize

	if startIndex >= totalLogs {
		return []LogEntry{}
	}
	if endIndex > totalLogs {
		endIndex = totalLogs
	}

	return lb.logs[startIndex:endIndex]
}

// Search는 메모리 버퍼에서 키워드를 검색합니다 (단순 구현)
func (lb *MemoryLogBuffer) Search(keyword string) []LogEntry {
	lb.mutex.RLock()
	defer lb.mutex.RUnlock()

	if keyword == "" {
		return []LogEntry{}
	}

	results := make([]LogEntry, 0)
	lowerKeyword := strings.ToLower(keyword)
	maxResults := SearchResultsSize

	for _, log := range lb.logs {
		if len(results) >= maxResults {
			break
		}
		if strings.Contains(strings.ToLower(log.Message), lowerKeyword) {
			results = append(results, log)
		}
	}

	return results
}

// ExitSearchMode는 메모리 버퍼에서는 빈 구현 (상태 없음)
func (lb *MemoryLogBuffer) ExitSearchMode() {
	// 메모리 버퍼는 검색 상태를 유지하지 않음
}

// IsSearchMode는 메모리 버퍼에서는 항상 false (검색 상태 없음)
func (lb *MemoryLogBuffer) IsSearchMode() bool {
	return false
}

// GetSearchResults는 메모리 버퍼에서는 빈 배열 반환 (검색 상태 없음)
func (lb *MemoryLogBuffer) GetSearchResults() []LogEntry {
	return []LogEntry{}
}

// GetStats는 버퍼 통계를 반환합니다
func (lb *MemoryLogBuffer) GetStats() map[string]interface{} {
	lb.mutex.RLock()
	defer lb.mutex.RUnlock()

	return map[string]interface{}{
		"type":          "memory",
		"total_logs":    len(lb.logs),
		"max_size":      lb.maxSize,
		"total_clients": len(lb.clients),
		"log_counter":   lb.logCounter,
		"total_added":   lb.totalAdded,
		"total_removed": lb.totalRemoved,
	}
}

// 하위 호환성을 위한 레거시 함수
// NewLogBuffer는 NewMemoryLogBuffer의 별칭입니다 (하위 호환성)
func NewLogBuffer(maxSize int) *MemoryLogBuffer {
	return NewMemoryLogBuffer(maxSize)
}
