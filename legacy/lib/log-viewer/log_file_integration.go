package logviewer

import (
	"bufio"
	"context"
	"edgetool/util"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

// 로그 파일 통합 관련 상수
const (
	TYPE_LOG_BUFFER_SIZE    = 500 // 타입별 로그 버퍼 크기
	MAIN_BUFFER_SIZE        = 500 // 최종 메인 버퍼 크기
	TIMEZONE_JUMP_THRESHOLD = 6   // 타임존 점프 감지 임계값 (시간)
)

// 웹 서버 관련 상수
const (
	DEFAULT_WEB_SERVER_PORT = 1204 // 기본 웹 서버 포트
)

// LogIndex는 로그의 메타데이터를 저장합니다
type LogIndex struct {
	Index         int       // 파일 내 라인 인덱스
	File          string    // 파일명
	FileLine      int       // 실제 파일 내 라인 번호
	OriginalTime  time.Time // 원본 시간
	CorrectedTime time.Time // 보정된 시간
}

// LogTypeData는 타입별 로그 데이터를 관리합니다
type LogTypeData struct {
	LogType     string     // 로그 타입 (system, homey, etc.)
	IndexBuffer []LogIndex // 인덱스 버퍼 (전체 메타데이터)
	LogBuffer   []LogEntry // 로그 버퍼 (실제 LogEntry, 청크 단위)
	Pointer     int        // 현재 처리 중인 인덱스 위치
	BufferStart int        // 로그 버퍼의 시작 인덱스
}

// LogFileIntegration은 로그 파일 통합 엔진입니다
type LogFileIntegration struct {
	LogTypes      map[string]*LogTypeData // 타입별 데이터
	MainBuffer    *HybridLogBuffer        // 최종 병합 버퍼
	totalLogCount int                     // 캐시된 총 로그 수
}

// NewLogFileIntegration은 새로운 로그 파일 통합 엔진을 생성합니다
func NewLogFileIntegration(logsDir string) *LogFileIntegration {
	return &LogFileIntegration{
		LogTypes: make(map[string]*LogTypeData),
		MainBuffer: NewHybridLogBuffer(LogBufferConfig{
			Type:           BufferTypeHybrid,
			MaxMemorySize:  1000,
			ViewportSize:   500,
			LogsDirectory:  logsDir,
			EnableIndexing: true,
		}),
	}
}

// LoadLogsFromDirectoryWithContext는 지정된 디렉토리에서 로그를 로드하고 통합합니다 (context 지원)
func (lfi *LogFileIntegration) LoadLogsFromDirectoryWithContext(ctx context.Context, dir string) error {
	startTime := time.Now()
	util.Log(util.ColorGreen, "📁 로그 파일 통합 시작: %s\n", dir)

	// raw 디렉토리 초기화 (임시 폴더 정리)
	if err := lfi.initializeRawDirectory(); err != nil {
		util.Log(util.ColorRed, "❌ raw 디렉토리 초기화 실패: %v\n", err)
		return fmt.Errorf("raw 디렉토리 초기화 실패: %v", err)
	}

	// 메모리 모니터링: 시작
	lfi.logMemoryUsage("통합 시작")

	// 1단계: 타입별 파일 스캔 및 인덱스 생성
	err := lfi.scanAllLogFiles(dir)
	if err != nil {
		return fmt.Errorf("로그 파일 스캔 실패: %v", err)
	}

	// 2단계: 타임존 점프 보정
	lfi.correctTimezoneJumps()

	// 3단계: 로그 버퍼 초기화
	err = lfi.initializeLogBuffers()
	if err != nil {
		return fmt.Errorf("로그 버퍼 초기화 실패: %v", err)
	}

	// 4단계: 병합 실행 (context 지원)
	totalMerged, err := lfi.mergeAllTypesWithContext(ctx)
	if err != nil {
		return fmt.Errorf("로그 병합 실패: %v", err)
	}

	// 통계 계산 및 출력
	elapsed := time.Since(startTime)
	logsPerSecond := float64(totalMerged) / elapsed.Seconds()

	util.Log(util.ColorGreen, "✅ 로그 파일 통합 완료\n")
	util.Log(util.ColorCyan, "📊 통계: %d개 로그 처리, %.2fs 소요 (%.1f logs/sec)\n",
		totalMerged, elapsed.Seconds(), logsPerSecond)

	// 메모리 모니터링: 통합 완료 (메인 버퍼 로드됨)
	lfi.logMemoryUsage("통합 완료")

	return nil
}

// scanAllLogFiles는 모든 로그 파일을 스캔하여 인덱스를 생성합니다
func (lfi *LogFileIntegration) scanAllLogFiles(dir string) error {
	// 메모리 모니터링: 인덱스 생성 시작
	lfi.logMemoryUsage("인덱스 생성 시작")

	// *.log 파일 찾기
	pattern := filepath.Join(dir, "*.log*")
	files, err := filepath.Glob(pattern)
	if err != nil {
		return fmt.Errorf("파일 스캔 실패: %v", err)
	}

	if len(files) == 0 {
		return fmt.Errorf("로그 파일을 찾을 수 없습니다: %s", dir)
	}

	util.Log(util.ColorCyan, "📄 발견된 로그 파일: %d개\n", len(files))

	// 파일을 타입별로 그룹화
	typeFiles := lfi.groupFilesByType(files)

	// 각 타입별로 인덱스 생성
	for logType, typeFileList := range typeFiles {
		util.Log(util.ColorCyan, "🔍 %s 타입 파일 처리 중...\n", logType)

		// 파일을 번호 순으로 정렬 (system.log.2 -> system.log.1 -> system.log)
		sortedFiles := lfi.sortFilesByNumber(typeFileList)

		// 타입 데이터 초기화
		lfi.LogTypes[logType] = &LogTypeData{
			LogType:     logType,
			IndexBuffer: make([]LogIndex, 0),
			Pointer:     0,
			BufferStart: 0,
		}

		// 각 파일에서 인덱스 생성
		err := lfi.createIndexForType(logType, sortedFiles)
		if err != nil {
			return fmt.Errorf("%s 타입 인덱스 생성 실패: %v", logType, err)
		}

		util.Log(util.ColorGreen, "✅ %s 타입: %d개 로그 인덱스 생성\n", logType, len(lfi.LogTypes[logType].IndexBuffer))
	}

	// 메모리 모니터링: 인덱스 생성 완료
	lfi.logMemoryUsage("인덱스 생성 완료")

	return nil
}

// groupFilesByType은 파일명에서 타입을 추출하여 그룹화합니다
func (lfi *LogFileIntegration) groupFilesByType(files []string) map[string][]string {
	typeFiles := make(map[string][]string)

	for _, file := range files {
		// 파일인지 디렉토리인지 확인
		fileInfo, err := os.Stat(file)
		if err != nil {
			util.Log(util.ColorYellow, "⚠️ 파일 정보 확인 실패 (스킵): %s - %v\n", file, err)
			continue
		}

		// 디렉토리면 스킵
		if fileInfo.IsDir() {
			util.Log(util.ColorYellow, "📁 디렉토리 스킵: %s\n", file)
			continue
		}

		base := filepath.Base(file)

		// 파일명에서 타입 추출 (예: system.log.1 -> system)
		var logType string
		if strings.Contains(base, ".log") {
			parts := strings.Split(base, ".log")
			logType = parts[0]
		} else {
			logType = "unknown"
		}

		if typeFiles[logType] == nil {
			typeFiles[logType] = make([]string, 0)
		}
		typeFiles[logType] = append(typeFiles[logType], file)
	}

	return typeFiles
}

// sortFilesByNumber는 파일을 번호 순으로 정렬합니다 (큰 번호부터)
func (lfi *LogFileIntegration) sortFilesByNumber(files []string) []string {
	type fileWithNumber struct {
		path string
		num  int
	}

	var fileList []fileWithNumber
	for _, f := range files {
		base := filepath.Base(f)
		num := 0

		// 번호 추출 (예: system.log.1 -> 1)
		if strings.Contains(base, ".log.") {
			parts := strings.Split(base, ".log.")
			if len(parts) == 2 {
				if n, err := strconv.Atoi(parts[1]); err == nil {
					num = n
				}
			}
		}

		fileList = append(fileList, fileWithNumber{f, num})
	}

	// 번호 내림차순 정렬 (큰 번호 = 이전 로그 우선)
	sort.Slice(fileList, func(i, j int) bool {
		return fileList[i].num > fileList[j].num
	})

	var sortedFiles []string
	for _, item := range fileList {
		sortedFiles = append(sortedFiles, item.path)
	}

	return sortedFiles
}

// createIndexForType은 특정 타입의 파일들에서 인덱스를 생성합니다
func (lfi *LogFileIntegration) createIndexForType(logType string, files []string) error {
	typeData := lfi.LogTypes[logType]

	for _, file := range files {
		f, err := os.Open(file)
		if err != nil {
			return fmt.Errorf("파일 열기 실패 %s: %v", file, err)
		}

		scanner := bufio.NewScanner(f)
		lineIndex := len(typeData.IndexBuffer) // 연속된 인덱스
		fileLine := 0                          // 실제 파일 내 라인 번호

		for scanner.Scan() {
			line := scanner.Text()
			fileLine++ // 파일 내 라인 번호 증가

			if line == "" {
				continue
			}

			// 로그 라인 파싱하여 시간 추출
			entry := ParseLogLine(line, lineIndex)
			if entry == nil {
				continue // 파싱 실패 시 스킵
			}

			// 출처 정보 설정 (파일명)
			entry.Source = filepath.Base(file)

			// 인덱스 추가
			index := LogIndex{
				Index:         lineIndex,
				File:          file,
				FileLine:      fileLine, // 실제 파일 라인 번호 저장
				OriginalTime:  entry.Timestamp,
				CorrectedTime: entry.Timestamp, // 초기값은 원본과 동일
			}

			typeData.IndexBuffer = append(typeData.IndexBuffer, index)
			lineIndex++
		}

		f.Close()

		if err := scanner.Err(); err != nil {
			return fmt.Errorf("파일 읽기 오류 %s: %v", file, err)
		}
	}

	return nil
}

// correctTimezoneJumps는 각 타입별로 타임존 점프를 감지하고 보정합니다
func (lfi *LogFileIntegration) correctTimezoneJumps() {
	for logType, typeData := range lfi.LogTypes {
		corrected := lfi.correctTimezoneJumpsForType(typeData.IndexBuffer)
		util.Log(util.ColorYellow, "🔧 %s 타입: %d개 타임존 점프 보정\n", logType, corrected)

		// 타임존 보정 후 IndexBuffer를 역순으로 정렬 (최근 것부터 오래된 것 순서)
		sort.Slice(typeData.IndexBuffer, func(i, j int) bool {
			return typeData.IndexBuffer[i].CorrectedTime.After(typeData.IndexBuffer[j].CorrectedTime)
		})
		util.Log(util.ColorCyan, "🔀 %s 타입 IndexBuffer 역순 정렬 완료 (%d개)\n", logType, len(typeData.IndexBuffer))
	}
}

// correctTimezoneJumpsForType은 특정 타입의 타임존 점프를 보정합니다
func (lfi *LogFileIntegration) correctTimezoneJumpsForType(indexes []LogIndex) int {
	if len(indexes) < 3 {
		return 0 // 비교할 로그가 부족
	}

	correctedCount := 0

	for i := 1; i < len(indexes)-1; i++ {
		current := &indexes[i]
		prev := indexes[i-1]
		next := indexes[i+1]

		// 시간 점프 감지 (임계값 이상 차이)
		hourDiff := abs(current.OriginalTime.Hour() - prev.OriginalTime.Hour())
		if hourDiff >= TIMEZONE_JUMP_THRESHOLD {
			// 다음 로그가 이전 시간대로 돌아왔는지 확인
			nextHourDiff := abs(next.OriginalTime.Hour() - prev.OriginalTime.Hour())
			if nextHourDiff < 3 { // 3시간 이내면 정상 복귀로 판단
				// 타임존 점프로 판단, 시간 보정 (hour만 조정)
				correctedTime := current.OriginalTime
				if current.OriginalTime.Hour() > 12 && prev.OriginalTime.Hour() < 12 {
					// UTC -> KST (19시 -> 10시대로 보정)
					correctedTime = correctedTime.Add(-9 * time.Hour)
				} else if current.OriginalTime.Hour() < 12 && prev.OriginalTime.Hour() > 12 {
					// KST -> UTC (10시 -> 19시대로 보정) - 보통 안 일어남
					correctedTime = correctedTime.Add(9 * time.Hour)
				}
				current.CorrectedTime = correctedTime
				correctedCount++
			}
		}
	}

	return correctedCount
}

// abs는 정수의 절댓값을 반환합니다
func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// GetMainBuffer는 병합된 메인 버퍼를 반환합니다
func (lfi *LogFileIntegration) GetMainBuffer() *HybridLogBuffer {
	return lfi.MainBuffer
}

// SetMainBuffer는 메인 버퍼를 설정합니다
func (lfi *LogFileIntegration) SetMainBuffer(buffer *HybridLogBuffer) {
	lfi.MainBuffer = buffer
}

// initializeRawDirectory는 raw 디렉토리를 초기화합니다
func (lfi *LogFileIntegration) initializeRawDirectory() error {
	if lfi.MainBuffer == nil {
		return fmt.Errorf("MainBuffer가 설정되지 않음")
	}

	// HybridLogBuffer의 fileStorage에서 raw 디렉토리 경로 가져오기
	rawDir := lfi.MainBuffer.GetRawDirectory()
	if rawDir == "" {
		return fmt.Errorf("raw 디렉토리 경로를 가져올 수 없음")
	}

	// raw 디렉토리 초기화 (기존 파일 모두 삭제 후 새로 생성)
	if err := cleanAndCreateRawDirectory(rawDir); err != nil {
		return fmt.Errorf("raw 디렉토리 초기화 실패: %v", err)
	}

	util.Log(util.ColorGreen, "✅ [LogFileIntegration] raw 디렉토리 초기화 완료: %s\n", rawDir)
	return nil
}

// logMemoryUsage는 현재 메모리 사용량을 로깅합니다
func (lfi *LogFileIntegration) logMemoryUsage(stage string) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	mb := float64(m.Alloc) / 1024 / 1024
	util.Log(util.ColorCyan, "📊 메모리 사용량: %.1fMB (%s)\n", mb, stage)
}

// initializeLogBuffers는 각 타입별 로그 버퍼를 초기화합니다
func (lfi *LogFileIntegration) initializeLogBuffers() error {
	for logType := range lfi.LogTypes {
		err := lfi.loadChunkForType(logType, 0)
		if err != nil {
			return fmt.Errorf("%s 타입 버퍼 초기화 실패: %v", logType, err)
		}

		// 타입별 로그 버퍼를 역순(최근 우선)으로 정렬
		lfi.sortTypeBufferByTimeDesc(logType)

		util.Log(util.ColorGreen, "🔄 %s 타입 로그 버퍼 초기화 및 역순 정렬 완료\n", logType)
	}

	// 메모리 모니터링: 버퍼 초기화 완료
	lfi.logMemoryUsage("버퍼 초기화 완료")

	return nil
}

// loadChunkForType은 특정 타입의 청크를 로드합니다
func (lfi *LogFileIntegration) loadChunkForType(logType string, startIndex int) error {
	typeData := lfi.LogTypes[logType]
	typeData.LogBuffer = make([]LogEntry, 0, TYPE_LOG_BUFFER_SIZE)
	typeData.BufferStart = startIndex

	endIndex := startIndex + TYPE_LOG_BUFFER_SIZE
	if endIndex > len(typeData.IndexBuffer) {
		endIndex = len(typeData.IndexBuffer)
	}

	// 각 인덱스에 해당하는 로그를 파일에서 읽어서 버퍼에 추가
	for i := startIndex; i < endIndex; i++ {
		index := typeData.IndexBuffer[i]
		entry, err := lfi.readLogEntryFromFile(index)
		if err != nil {
			util.Log(util.ColorYellow, "⚠️ 로그 읽기 실패 %s:%d - %v\n", index.File, index.FileLine, err)
			continue // 에러 처리 개선: 로깅 후 계속 진행
		}
		typeData.LogBuffer = append(typeData.LogBuffer, *entry)
	}

	util.Log(util.ColorCyan, "📖 %s 타입: %d-%d 청크 로드 완료 (%d개)\n",
		logType, startIndex, endIndex-1, len(typeData.LogBuffer))

	return nil
}

// readLogEntryFromFile은 파일에서 특정 라인의 로그를 읽어 LogEntry를 생성합니다
func (lfi *LogFileIntegration) readLogEntryFromFile(index LogIndex) (*LogEntry, error) {
	f, err := os.Open(index.File)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	lineNum := 1                 // 1부터 시작
	targetLine := index.FileLine // 실제 파일 라인 번호 사용

	for scanner.Scan() {
		if lineNum == targetLine {
			line := scanner.Text()
			entry := ParseLogLine(line, index.Index)
			if entry != nil {
				entry.Source = filepath.Base(index.File)
			}
			return entry, nil
		}
		lineNum++
	}

	return nil, fmt.Errorf("라인을 찾을 수 없음: %d", targetLine)
}

// getTotalLogCount는 모든 타입의 총 로그 수를 계산합니다
func (lfi *LogFileIntegration) getTotalLogCount() int {
	// 캐시된 값이 있으면 바로 반환
	if lfi.totalLogCount > 0 {
		return lfi.totalLogCount
	}

	// IndexBuffer 합계 계산 및 캐시
	total := 0
	for _, typeData := range lfi.LogTypes {
		total += len(typeData.IndexBuffer)
	}
	lfi.totalLogCount = total
	return total
}

// mergeAllTypesWithContext는 모든 타입의 로그를 병합합니다 (context 지원, 취소 가능)
func (lfi *LogFileIntegration) mergeAllTypesWithContext(ctx context.Context) (int, error) {
	util.Log(util.ColorGreen, "🔀 로그 병합 시작 (배치 모드)...\n")

	// 전체 로그 수 계산
	totalLogs := lfi.getTotalLogCount()
	util.Log(util.ColorCyan, "📊 전체 로그 수: %d개\n", totalLogs)

	const batchSize = 500
	batch := make([]LogEntry, 0, batchSize)
	totalMerged := 0

	for !lfi.allPointersAtEnd() {
		// context 취소 체크
		select {
		case <-ctx.Done():
			util.Log(util.ColorYellow, "🔄 로그 병합이 취소되었습니다\n")
			return 0, ctx.Err()
		default:
		}

		// 각 타입의 현재 로그 중 가장 큰 CorrectedTime 찾기 (역순 병합)
		selectedType := lfi.findMaxCorrectedTimeType()
		if selectedType == "" {
			break
		}

		// 해당 타입에서 로그 가져오기
		typeData := lfi.LogTypes[selectedType]
		bufferIndex := typeData.Pointer - typeData.BufferStart

		if bufferIndex < len(typeData.LogBuffer) {
			logEntry := typeData.LogBuffer[bufferIndex]
			// 전체 인덱스 재설정 (연속적인 인덱스 부여)
			logEntry.Index = totalMerged + 1
			batch = append(batch, logEntry)
			totalMerged++

			// 배치가 가득 차면 한 번에 추가
			if len(batch) >= batchSize {
				for _, entry := range batch {
					lfi.MainBuffer.AddLog(entry)
				}
				batch = batch[:0] // 슬라이스 재사용

				// 진행률 표시 (배치 단위로) + 메모리 모니터링 (10%마다)
				progress := float64(totalMerged) / float64(totalLogs) * 100
				if totalMerged%1000 == 0 || (totalLogs > 0 && int(progress)%10 == 0 && int(progress) > 0) {
					var m runtime.MemStats
					runtime.ReadMemStats(&m)
					mb := float64(m.Alloc) / 1024 / 1024
					util.Log(util.ColorCyan, "🔀 병합 진행: %d개 완료 (%.1f%% 완료) - 메모리: %.1fMB\n", totalMerged, progress, mb)
				}
			}
		}

		// 포인터 증가
		typeData.Pointer++

		// 버퍼 리필 필요 시 (실시간 체크)
		bufferIndex = typeData.Pointer - typeData.BufferStart
		if bufferIndex >= len(typeData.LogBuffer) && typeData.Pointer < len(typeData.IndexBuffer) {
			// 버퍼가 부족하고 아직 읽을 인덱스가 있으면 리필
			lfi.loadChunkForType(selectedType, typeData.Pointer)
		}
	}

	// 남은 배치 처리
	if len(batch) > 0 {
		for _, entry := range batch {
			lfi.MainBuffer.AddLog(entry)
		}
	}

	// 메모리 모니터링: 병합 완료
	lfi.logMemoryUsage("병합 완료")

	// 메모리 해제: 인덱스 버퍼 해제
	for _, typeData := range lfi.LogTypes {
		typeData.IndexBuffer = nil // 메모리 해제
	}

	util.Log(util.ColorGreen, "✅ 로그 병합 완료: 총 %d개 로그 (배치 최적화 적용)\n", totalMerged)
	return totalMerged, nil
} // allPointersAtEnd는 모든 포인터가 끝에 도달했는지 확인합니다
func (lfi *LogFileIntegration) allPointersAtEnd() bool {
	for _, typeData := range lfi.LogTypes {
		if typeData.Pointer < len(typeData.IndexBuffer) {
			return false
		}
	}
	return true
}

// findMaxCorrectedTimeType은 현재 가장 큰 보정 시간을 가진 타입을 찾습니다 (역순 병합용)
func (lfi *LogFileIntegration) findMaxCorrectedTimeType() string {
	var maxType string
	var maxTime time.Time

	for logType, typeData := range lfi.LogTypes {
		if typeData.Pointer >= len(typeData.IndexBuffer) {
			continue // 이미 끝남
		}

		currentIndex := typeData.IndexBuffer[typeData.Pointer]
		correctedTime := currentIndex.CorrectedTime

		if maxType == "" || correctedTime.After(maxTime) {
			maxType = logType
			maxTime = correctedTime
		}
	}

	return maxType
}

// sortTypeBufferByTimeDesc는 특정 타입의 로그 버퍼를 시간 역순(최근 우선)으로 정렬합니다
func (lfi *LogFileIntegration) sortTypeBufferByTimeDesc(logType string) {
	typeData := lfi.LogTypes[logType]
	if len(typeData.LogBuffer) <= 1 {
		return
	}

	sort.Slice(typeData.LogBuffer, func(i, j int) bool {
		// 시간 역순: 더 최근(큰 시간)이 먼저 오도록
		return typeData.LogBuffer[i].Timestamp.After(typeData.LogBuffer[j].Timestamp)
	})

	util.Log(util.ColorCyan, "🔀 %s 타입 로그 버퍼 역순 정렬 완료 (%d개)\n",
		logType, len(typeData.LogBuffer))
}
