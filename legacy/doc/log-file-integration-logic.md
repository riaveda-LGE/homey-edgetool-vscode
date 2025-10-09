# Log File Integration Logic (시간 역순 병합 버전)

## 개요
LogFileIntegration은 여러 타입의 로그 파일을 **시간 역순으로 통합**하여 HybridLogBuffer에 로드하는 컴포넌트입니다. 타임존 점프 문제를 자동 감지 및 보정하여 **최근 로그 우선**의 정확한 역순 병합을 제공합니다.

## 핵심 구조체

### LogTypeData 구조체
```go
type LogTypeData struct {
    TypeName      string            // 로그 타입명 ("system", "homey", "application")
    Files         []string          // 정렬된 파일 목록 (최신순)
    CurrentFile   string            // 현재 처리 중인 파일
    CurrentIndex  int               // 파일 내 현재 라인 인덱스
    TotalLines    int64             // 총 라인 수
    LastTimestamp time.Time         // 마지막 로그 타임스탬프
    Timezone      *time.Location    // 해당 타입의 타임존
    Status        string            // "scanning", "processing", "completed"
    Error         error             // 처리 중 에러
}
```

**역할**: 각 로그 타입의 메타데이터와 처리 상태를 관리

### LogFileIntegration 구조체
```go
type LogFileIntegration struct {
    LogTypes      map[string]*LogTypeData  // 타입별 데이터
    MainBuffer    *HybridLogBuffer         // 통합 버퍼
    Timezone      *time.Location           // 기본 타임존
    MaxChunkSize  int                      // 청크 단위 크기
    IsRunning     bool                     // 처리 중 상태
    stopChan      chan bool                // 정지 신호
}
```

**역할**: 멀티 로그 타입 통합 처리의 중앙 컨트롤러

## 처리 아키텍처

### 전체 데이터 흐름
```
로그 파일들 (*.log/*.jsonl) → LogTypeData 스캔 → 타임존 보정 → 청크 로드 → HybridLogBuffer
    ↓
LogFileIntegration.ProcessLogFiles() → 각 타입별 병렬 처리 → 통합 버퍼 저장
```

### 처리 단계 상세

#### 1단계: 로그 타입 스캔 및 초기화
```go
func (lfi *LogFileIntegration) LoadLogFiles(logsDir string) error {
    // 1. 디렉토리 내 모든 로그 파일 찾기
    files, err := filepath.Glob(filepath.Join(logsDir, "*.log"))
    if err != nil {
        return err
    }

    // 2. 파일들을 타입별로 분류
    typeFiles := make(map[string][]string)
    for _, file := range files {
        logType := extractLogType(file) // "system", "homey" 등
        typeFiles[logType] = append(typeFiles[logType], file)
    }

    // 3. 각 타입별로 LogTypeData 생성 및 파일 정렬
    for logType, files := range typeFiles {
        sortedFiles := sortFilesByRotation(files) // .2, .1, "" 순
        lfi.LogTypes[logType] = &LogTypeData{
            TypeName: logType,
            Files:    sortedFiles,
            Status:   "scanning",
        }
    }

    return nil
}
```

#### 2단계: 타임존 보정 로직
```go
func (lfi *LogFileIntegration) correctTimezoneJumps(entries []LogEntry) []LogEntry {
    if len(entries) < 3 {
        return entries
    }

    corrected := make([]LogEntry, len(entries))
    copy(corrected, entries)

    for i := 1; i < len(corrected)-1; i++ {
        current := corrected[i]
        prev := corrected[i-1]
        next := corrected[i+1]

        // 시간 점프 감지 (9시간 이상 차이)
        hourDiff := math.Abs(float64(current.Timestamp.Hour() - prev.Timestamp.Hour()))
        if hourDiff >= 9 {
            // 다음 로그가 이전 시간대로 돌아왔는지 확인
            nextHourDiff := math.Abs(float64(next.Timestamp.Hour() - prev.Timestamp.Hour()))
            if nextHourDiff < 2 {
                // 타임존 점프 판정 - 시간을 보정
                corrected[i].Timestamp = lfi.adjustTimestamp(current.Timestamp, prev.Timestamp)
                log.Printf("타임존 점프 보정: %v → %v", current.Timestamp, corrected[i].Timestamp)
            }
        }
    }

    return corrected
}

func (lfi *LogFileIntegration) adjustTimestamp(ts, reference time.Time) time.Time {
    // 시간을 reference와 같은 시간대로 조정
    hourDiff := reference.Hour() - ts.Hour()
    if hourDiff < -12 {
        hourDiff += 24
    } else if hourDiff > 12 {
        hourDiff -= 24
    }

    return ts.Add(time.Duration(hourDiff) * time.Hour)
}
```

#### 3단계: 청크 단위 파일 처리
```go
func (lfi *LogFileIntegration) processLogTypeChunk(logType string, startLine int64) ([]LogEntry, error) {
    typeData := lfi.LogTypes[logType]
    if typeData.Status == "completed" {
        return nil, nil
    }

    var allEntries []LogEntry

    // 현재 파일에서 청크 크기만큼 읽기
    for len(allEntries) < lfi.MaxChunkSize && typeData.CurrentIndex < len(typeData.Files) {
        currentFile := typeData.Files[typeData.CurrentIndex]

        entries, err := lfi.readLogFileChunk(currentFile, startLine, lfi.MaxChunkSize-len(allEntries))
        if err != nil {
            return nil, err
        }

        if len(entries) == 0 {
            // 파일 끝에 도달, 다음 파일로 이동
            typeData.CurrentIndex++
            startLine = 0
            continue
        }

        // 타임존 보정 적용
        correctedEntries := lfi.correctTimezoneJumps(entries)

        // 각 엔트리에 타입 정보 추가
        for i := range correctedEntries {
            correctedEntries[i].Type = logType
            correctedEntries[i].Source = currentFile
        }

        allEntries = append(allEntries, correctedEntries...)
        startLine += int64(len(entries))
    }

    // 모든 파일 처리 완료 체크
    if typeData.CurrentIndex >= len(typeData.Files) {
        typeData.Status = "completed"
    }

    return allEntries, nil
}
```

#### 4단계: 통합 버퍼로 로드
```go
func (lfi *LogFileIntegration) ProcessLogFiles() error {
    lfi.IsRunning = true
    defer func() { lfi.IsRunning = false }()

    // 각 타입별로 병렬 처리
    for logType := range lfi.LogTypes {
        go lfi.processLogTypeContinuously(logType)
    }

    // 정지 신호 대기
    <-lfi.stopChan
    return nil
}

func (lfi *LogFileIntegration) processLogTypeContinuously(logType string) {
    startLine := int64(0)

    for lfi.IsRunning {
        // 청크 단위로 로그 처리
        entries, err := lfi.processLogTypeChunk(logType, startLine)
        if err != nil {
            log.Printf("로그 타입 %s 처리 에러: %v", logType, err)
            continue
        }

        if len(entries) == 0 {
            // 더 이상 처리할 로그 없음
            break
        }

        // HybridLogBuffer에 추가
        for _, entry := range entries {
            lfi.MainBuffer.AddLog(entry)
        }

        startLine += int64(len(entries))

        // 처리 속도 조절 (너무 빠른 처리 방지)
        time.Sleep(100 * time.Millisecond)
    }
}
```

#### 5단계: 타입별 역순 정렬
```go
func (lfi *LogFileIntegration) initializeLogBuffers() error {
    // 각 타입별 버퍼 초기화
    for logType, typeData := range lfi.LogTypes {
        // ... 버퍼 초기화 코드 ...
        
        // 타입별 로그들을 시간 역순으로 정렬
        lfi.sortTypeBufferByTimeDesc(logType)
    }
    return nil
}

func (lfi *LogFileIntegration) sortTypeBufferByTimeDesc(logType string) {
    typeData := lfi.LogTypes[logType]
    
    // 해당 타입의 모든 로그 엔트리를 시간 역순으로 정렬
    sort.Slice(typeData.Entries, func(i, j int) bool {
        return typeData.Entries[i].Timestamp.After(typeData.Entries[j].Timestamp)
    })
    
    log.Printf("로그 타입 %s: %d개 엔트리 시간 역순 정렬 완료", logType, len(typeData.Entries))
}
```

**역할**: 각 로그 타입 내에서 시간 역순 정렬을 수행하여 타입별로 최근 로그가 먼저 오도록 함

#### 6단계: 타입간 역순 병합
```go
func (lfi *LogFileIntegration) mergeAllTypesWithContext() {
    for lfi.IsRunning {
        // 가장 최근 타임스탬프를 가진 타입 찾기 (역순 병합)
        selectedType := lfi.findMaxCorrectedTimeType()
        if selectedType == "" {
            // 모든 타입 처리 완료
            break
        }

        typeData := lfi.LogTypes[selectedType]
        
        // 선택된 타입에서 다음 로그 엔트리 가져오기
        if len(typeData.Entries) > 0 {
            entry := typeData.Entries[0]
            typeData.Entries = typeData.Entries[1:] // 큐에서 제거
            
            // HybridLogBuffer에 추가
            lfi.MainBuffer.AddLog(entry)
        }
    }
}

func (lfi *LogFileIntegration) findMaxCorrectedTimeType() string {
    var maxTime time.Time
    var selectedType string
    
    // 모든 활성 타입 중 가장 큰 타임스탬프를 가진 타입 선택
    for logType, typeData := range lfi.LogTypes {
        if typeData.Status != "completed" && len(typeData.Entries) > 0 {
            entryTime := typeData.Entries[0].Timestamp
            if entryTime.After(maxTime) {
                maxTime = entryTime
                selectedType = logType
            }
        }
    }
    
    return selectedType
}
```

**역할**: 타입간 시간 역순 병합을 수행하여 전체 로그 스트림에서 최근 로그가 우선적으로 표시되도록 함

## 타임존 보정 예시

### 입력 데이터
**system.log** (타임존 점프 발생):
```
2023-10-04 10:01:00 [INFO] 시스템 시작
2023-10-04 10:03:00 [INFO] 서비스 실행
2023-10-04 19:05:00 [INFO] 타임존 UTC로 변경됨 (실제로는 10:05)
2023-10-04 10:07:00 [INFO] 타임존 KST로 복귀
```

**homey.log** (정상):
```
2023-10-04 10:02:00 [INFO] Homey 앱 로드
2023-10-04 10:04:00 [INFO] 디바이스 연결
2023-10-04 10:06:00 [INFO] 로그 수집 시작
2023-10-04 10:08:00 [INFO] 모니터링 활성화
```

### 보정 과정
```
원본 system.log:
10:01 → 10:03 → 19:05 → 10:07

타임존 점프 감지:
- 10:03 → 19:05: 9시간 점프 감지
- 다음 로그 10:07이 10:03과 가까움 → 점프 판정
- 19:05 → 10:05로 보정

보정 후 system.log:
10:01 → 10:03 → 10:05 → 10:07
```

### 최종 병합 결과 (역순, 최근 우선)
```
10:08 (homey) - 10:07 (system) - 10:06 (homey) - 10:05 (system) - 10:04 (homey) - 10:03 (system) - 10:02 (homey) - 10:01 (system)
```

**역순 병합의 장점**: 가장 최근 로그가 먼저 표시되어 사용자가 중요한 최신 정보를 우선적으로 확인할 수 있습니다.

## 메모리 및 성능 최적화

### 메모리 관리
- **청크 크기**: 기본 500개 엔트리 단위 처리
- **타입별 버퍼링**: 각 타입 독립적 메모리 관리
- **스트리밍 처리**: 대용량 파일도 점진적 로드

### 성능 특징
- **병렬 처리**: 각 로그 타입별 고루틴으로 동시 처리
- **청크 I/O**: 파일을 작은 단위로 읽어 메모리 효율성 확보
- **타임존 보정**: 실시간으로 시간순 정렬 보장
- **WebSocket 통합**: 처리된 로그 즉시 실시간 전송

### 모니터링 포인트
```go
// 각 타입별 처리 상태 확인
func (lfi *LogFileIntegration) GetStatus() map[string]interface{} {
    status := make(map[string]interface{})
    for logType, typeData := range lfi.LogTypes {
        status[logType] = map[string]interface{}{
            "status":        typeData.Status,
            "current_file":  typeData.CurrentFile,
            "total_lines":   typeData.TotalLines,
            "last_timestamp": typeData.LastTimestamp,
            "error":         typeData.Error,
        }
    }
    return status
}
```

## 에러 처리 및 복원

### 파일 읽기 에러
```go
func (lfi *LogFileIntegration) readLogFileChunk(filename string, startLine, maxLines int64) ([]LogEntry, error) {
    file, err := os.Open(filename)
    if err != nil {
        return nil, fmt.Errorf("파일 열기 실패 %s: %w", filename, err)
    }
    defer file.Close()

    // startLine부터 maxLines만큼 읽기
    scanner := bufio.NewScanner(file)
    lineNum := int64(0)
    var entries []LogEntry

    for scanner.Scan() && int64(len(entries)) < maxLines {
        lineNum++
        if lineNum <= startLine {
            continue
        }

        entry, err := lfi.parseLogLine(scanner.Text(), filename)
        if err != nil {
            // 파싱 에러는 로그만 남기고 계속 진행
            log.Printf("로그 파싱 에러 (%s:%d): %v", filename, lineNum, err)
            continue
        }

        entries = append(entries, *entry)
    }

    return entries, scanner.Err()
}
```

### 타임존 보정 실패
- 기본적으로 원본 시간을 유지
- 보정 실패 로그만 남김
- 전체 처리 중단하지 않음

## 확장성

### 새로운 로그 타입 추가
```go
// 타입 감지 로직 확장
func extractLogType(filename string) string {
    base := filepath.Base(filename)

    switch {
    case strings.Contains(base, "system"):
        return "system"
    case strings.Contains(base, "homey"):
        return "homey"
    case strings.Contains(base, "application"):
        return "application"
    default:
        return "unknown"
    }
}
```

### 설정 기반 커스터마이징
```go
type LogFileIntegrationConfig struct {
    MaxChunkSize    int
    Timezone        *time.Location
    FilePatterns    []string          // "*.log", "*.jsonl" 등
    TypeMappings    map[string]string // 파일명 패턴 → 타입 매핑
    ErrorTolerance  int               // 허용 에러 수
}
```

## 결론

LogFileIntegration은 복잡한 로그 파일 통합 시나리오를 효율적으로 처리하는 핵심 컴포넌트입니다.

### 주요 강점
- **타임존 보정**: 시스템 오류로 인한 시간 점프 자동 감지 및 수정
- **역순 병합**: 최근 로그 우선으로 사용자 경험 최적화
- **타입별 역순 정렬**: 각 로그 타입 내 시간 역순 정렬로 타입별 일관성 보장
- **타입간 역순 병합**: findMaxCorrectedTimeType()으로 전체 스트림의 시간 순서 유지
- **메모리 효율**: 청크 단위 처리로 대용량 파일 안전하게 처리
- **병렬 처리**: 각 로그 타입별 독립적 고루틴으로 성능 최적화
- **실시간 통합**: HybridLogBuffer와의 긴밀한 연동으로 즉시 표시
- **에러 복원**: 부분적 실패가 전체 처리 중단하지 않음

### 사용법
```go
// LogFileIntegration 생성
lfi := &LogFileIntegration{
    LogTypes:     make(map[string]*LogTypeData),
    MainBuffer:   hybridBuffer,
    Timezone:     time.Local,
    MaxChunkSize: 500,
    stopChan:     make(chan bool),
}

// 로그 파일 로드 및 처리 시작
err := lfi.LoadLogFiles("./logs")
if err != nil {
    return err
}

go lfi.ProcessLogFiles() // 백그라운드 처리 시작
```

이 컴포넌트는 Edge Tool의 로그 뷰어 기능을 호스트 연결 없이도 완전히 구현할 수 있게 해줍니다.
