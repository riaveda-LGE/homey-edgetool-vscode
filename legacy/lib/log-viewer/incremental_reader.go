package logviewer

import (
	"bufio"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// IncrementalLogReader는 증분 로그 읽기를 처리합니다
type IncrementalLogReader struct {
	filePath      string
	lastPosition  int64
	lastLineCount int
	file          *os.File
	mutex         sync.RWMutex
	subscribers   []chan *LogEntry
	maxLogs       int         // 최대 로그 수 제한
	logBuffer     []*LogEntry // 로그 버퍼 (메모리 정리용)
}

// LogUpdate는 WebSocket으로 전송할 업데이트 메시지입니다
type LogUpdate struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

// NewIncrementalLogReader는 새로운 증분 로그 리더를 생성합니다
func NewIncrementalLogReader(filePath string) *IncrementalLogReader {
	return &IncrementalLogReader{
		filePath:      filePath,
		lastPosition:  0,
		lastLineCount: 0,
		subscribers:   make([]chan *LogEntry, 0),
		maxLogs:       10000, // 최대 로그 수 제한
		logBuffer:     make([]*LogEntry, 0),
	}
}

// Subscribe는 새로운 로그 엔트리 구독자를 추가합니다
func (ilr *IncrementalLogReader) Subscribe() chan *LogEntry {
	ilr.mutex.Lock()
	defer ilr.mutex.Unlock()

	ch := make(chan *LogEntry, 100) // 버퍼 크기 100
	ilr.subscribers = append(ilr.subscribers, ch)
	return ch
}

// Unsubscribe는 구독자를 제거합니다
func (ilr *IncrementalLogReader) Unsubscribe(ch chan *LogEntry) {
	ilr.mutex.Lock()
	defer ilr.mutex.Unlock()

	for i, subscriber := range ilr.subscribers {
		if subscriber == ch {
			close(ch)
			ilr.subscribers = append(ilr.subscribers[:i], ilr.subscribers[i+1:]...)
			break
		}
	}
}

// Start는 파일 모니터링을 시작합니다
func (ilr *IncrementalLogReader) Start() error {
	// 파일이 존재하지 않으면 대기
	for {
		if _, err := os.Stat(ilr.filePath); err == nil {
			break
		}
		time.Sleep(1 * time.Second)
	}

	// 초기 로드
	if err := ilr.loadInitialLogs(); err != nil {
		return fmt.Errorf("초기 로그 로드 실패: %v", err)
	}

	// 주기적 모니터링 시작
	go ilr.monitorFile()

	return nil
}

// loadInitialLogs는 기존 로그를 모두 로드합니다 (스트리밍 모드: 빈 상태로 시작)
func (ilr *IncrementalLogReader) loadInitialLogs() error {
	// 스트리밍 모드: 기존 로그 로드하지 않고 빈 상태로 시작
	// 파일이 존재하는지만 확인
	if _, err := os.Stat(ilr.filePath); err != nil {
		return fmt.Errorf("로그 파일이 존재하지 않음: %v", err)
	}

	// 파일 크기 확인하여 마지막 위치 설정
	stat, err := os.Stat(ilr.filePath)
	if err != nil {
		return err
	}

	ilr.lastPosition = stat.Size()
	ilr.lastLineCount = 0
	ilr.logBuffer = make([]*LogEntry, 0) // 빈 버퍼로 시작

	log.Printf("📊 스트리밍 모드 초기화 완료: 파일 크기 %d bytes, 빈 상태로 시작", stat.Size())
	return nil
}

// monitorFile은 파일 변경을 모니터링합니다
func (ilr *IncrementalLogReader) monitorFile() {
	ticker := time.NewTicker(1 * time.Second) // 1초마다 확인
	defer ticker.Stop()

	log.Printf("🔍 [모니터링 시작] 파일: %s", ilr.filePath)

	for range ticker.C {
		if err := ilr.readNewLines(); err != nil {
			log.Printf("❌ 새 로그 읽기 실패: %v", err)
		}
	}
}

// readNewLines는 새로 추가된 라인만 읽습니다
func (ilr *IncrementalLogReader) readNewLines() error {
	ilr.mutex.Lock()
	defer ilr.mutex.Unlock()

	// 파일 크기 확인
	stat, err := os.Stat(ilr.filePath)
	if err != nil {
		log.Printf("❌ 파일 상태 확인 실패: %v", err)
		return err
	}

	currentSize := stat.Size()
	log.Printf("🔍 [파일 체크] 현재 크기: %d bytes, 마지막 위치: %d", currentSize, ilr.lastPosition)

	// 크기가 변경되지 않았으면 스킵
	if currentSize <= ilr.lastPosition {
		log.Printf("🔍 [파일 체크] 크기 변경 없음")
		return nil
	}

	log.Printf("🔄 [파일 변경 감지] 크기 증가: %d -> %d", ilr.lastPosition, currentSize)

	// 파일 열기
	file, err := os.Open(ilr.filePath)
	if err != nil {
		log.Printf("❌ 파일 열기 실패: %v", err)
		return err
	}
	defer file.Close()

	// 마지막 위치로 이동
	if _, err := file.Seek(ilr.lastPosition, 0); err != nil {
		log.Printf("❌ 파일 위치 이동 실패: %v", err)
		return err
	}

	// 새 라인들 읽기
	scanner := bufio.NewScanner(file)
	newLines := 0

	for scanner.Scan() {
		line := scanner.Text()
		log.Printf("📄 [새 라인] 읽음: %s", line)
		if line == "" {
			continue
		}

		entry := ParseLogLine(line, ilr.lastLineCount+newLines)
		if entry != nil {
			entry.Source = filepath.Base(ilr.filePath) // 파일명만 추출
		}
		ilr.broadcastToSubscribers(entry)
		newLines++
	}

	if newLines > 0 {
		// 위치 업데이트
		ilr.lastPosition = currentSize
		ilr.lastLineCount += newLines
		log.Printf("🔄 새 로그 %d줄 추가됨 (총 %d줄)", newLines, ilr.lastLineCount)
	} else {
		log.Printf("🔍 새 라인 없음")
	}

	return scanner.Err()
}

// broadcastToSubscribers는 모든 구독자에게 로그 엔트리를 전송합니다
func (ilr *IncrementalLogReader) broadcastToSubscribers(entry *LogEntry) {
	log.Printf("📤 [브로드캐스트] 로그 엔트리 전송: %s", entry.Message)

	// 로그 버퍼에 추가
	ilr.logBuffer = append(ilr.logBuffer, entry)

	// 최대 로그 수 초과 시 오래된 로그 정리 (절반 제거)
	if len(ilr.logBuffer) > ilr.maxLogs {
		half := ilr.maxLogs / 2
		ilr.logBuffer = ilr.logBuffer[len(ilr.logBuffer)-half:]
		log.Printf("🧹 서버 측 오래된 로그 정리: %d개 남음", len(ilr.logBuffer))
	}

	// 구독자에게 전송
	subscriberCount := 0
	for _, ch := range ilr.subscribers {
		select {
		case ch <- entry:
			subscriberCount++
		default:
			// 채널이 가득 참, 스킵
			log.Printf("⚠️ 구독자 채널이 가득 참")
		}
	}

	log.Printf("📤 [브로드캐스트 완료] %d개 구독자에게 전송", subscriberCount)
}

// GetAllLogs는 현재까지의 모든 로그를 반환합니다 (스트리밍 모드: 버퍼에서 최근 로그 반환)
func (ilr *IncrementalLogReader) GetAllLogs() ([]*LogEntry, error) {
	ilr.mutex.RLock()
	defer ilr.mutex.RUnlock()

	// 스트리밍 모드: 버퍼의 최근 로그 반환 (최대 1000개)
	bufferLen := len(ilr.logBuffer)
	if bufferLen == 0 {
		return []*LogEntry{}, nil
	}

	// 최근 1000개만 반환
	start := 0
	if bufferLen > 1000 {
		start = bufferLen - 1000
	}

	return append([]*LogEntry{}, ilr.logBuffer[start:]...), nil
}

// Close는 리더를 정리합니다
func (ilr *IncrementalLogReader) Close() {
	ilr.mutex.Lock()
	defer ilr.mutex.Unlock()

	// 모든 구독자 채널 닫기
	for _, ch := range ilr.subscribers {
		close(ch)
	}
	ilr.subscribers = nil

	if ilr.file != nil {
		ilr.file.Close()
	}
}
