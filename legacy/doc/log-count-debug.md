# 로그 수 디버깅 가이드 (HybridLogBuffer 버전)

## 개요

HybridLogBuffer의 4-버퍼 시스템에서 각 버퍼별 로그 수와 웹 로그 뷰어의 출력 로그 수를 정확히 비교하여 차이의 원인을 분석합니다.

## HybridLogBuffer 4-버퍼 구조

```go
type HybridLogBuffer struct {
    realtimeLogs    []LogEntry    // 실시간 로그 (최신 1000개)
    viewportLogs1   []LogEntry    // 뷰포트 캐시1 (500개)
    viewportLogs2   []LogEntry    // 뷰포트 캐시2 (500개)
    searchResults   []LogEntry    // 검색 결과 버퍼 (100개)
    // ... 기타 필드
}
```

## 디버깅 원칙

- **4-버퍼 인식**: 각 버퍼의 역할을 정확히 이해
- **실시간 동기화**: 버퍼 상태 변화 시 즉시 디버그 로그
- **WebSocket 추적**: 메시지 타입별 전송/수신 카운트
- **메모리 상태**: 각 버퍼의 현재 크기 모니터링

## 디버그 로그 위치

### Go 서버 (HybridLogBuffer)

각 버퍼별 로그 수를 실시간으로 모니터링:

```go
// HybridLogBuffer에 디버그 메서드 추가
func (hb *HybridLogBuffer) DebugCounts() {
    util.Log(util.ColorCyan, "🔍 [DEBUG] HybridLogBuffer 상태:\n")
    util.Log(util.ColorCyan, "  realtimeLogs: %d개\n", len(hb.realtimeLogs))
    util.Log(util.ColorCyan, "  viewportLogs1: %d개\n", len(hb.viewportLogs1))
    util.Log(util.ColorCyan, "  viewportLogs2: %d개\n", len(hb.viewportLogs2))
    util.Log(util.ColorCyan, "  searchResults: %d개\n", len(hb.searchResults))

    total := len(hb.realtimeLogs) + len(hb.viewportLogs1) + len(hb.viewportLogs2) + len(hb.searchResults)
    util.Log(util.ColorGreen, "  총계: %d개\n", total)
}

// 주요 이벤트마다 호출
func (hb *HybridLogBuffer) AddLog(entry LogEntry) {
    // ... 기존 로직 ...
    if debugEnabled {
        hb.DebugCounts()
    }
}
```

### 웹 로그 뷰어 (LogViewer.js)

실제 표시된 로그 수와 WebSocket 수신 상태를 추적:

```javascript
class LogViewer {
    constructor() {
        this.logs = [];           // 실제 표시된 로그
        this.websocketReceived = 0; // WebSocket으로 받은 총 로그 수
        this.displayedCount = 0;   // 화면에 렌더링된 로그 수
    }

    updateDebugInfo() {
        console.log('[DEBUG] 웹 뷰어 상태:', {
            logsArray: this.logs.length,
            websocketReceived: this.websocketReceived,
            displayedCount: this.displayedCount,
            visibleLogs: document.querySelectorAll('.log-entry').length
        });
    }

    // 로그 추가 시마다 호출
    addLog(entry) {
        this.logs.push(entry);
        this.websocketReceived++;
        this.updateDisplayedCount();
        this.updateDebugInfo();
    }
}
```

### WebSocket 서비스 (WebSocketService.js)

메시지 타입별 수신 카운트를 추적:

```javascript
class WebSocketService {
    constructor() {
        this.messageCounts = {
            new_log: 0,
            batch_logs: 0,
            scroll_response: 0,
            search_response: 0
        };
    }

    handleMessage(message) {
        this.messageCounts[message.type] = (this.messageCounts[message.type] || 0) + 1;

        if (message.type === 'batch_logs' && message.logs) {
            this.messageCounts[message.type] += message.logs.length - 1; // 이미 1 더했으므로
        }

        console.log('[DEBUG] WebSocket 메시지 카운트:', this.messageCounts);
    }
}
```

## 버퍼별 예상 동작

### 실시간 모니터링 시나리오
```
Go 서버 디버그:
  realtimeLogs: 450개 (실시간 증가)
  viewportLogs1: 0개 (사용 안 함)
  viewportLogs2: 0개 (사용 안 함)
  searchResults: 0개 (검색 안 함)
  총계: 450개

웹 뷰어:
  logsArray: 450개
  websocketReceived: 450개 (new_log 메시지)
```

### 스크롤 탐색 시나리오
```
사용자가 30% 위치로 스크롤
→ viewportLogs1에 500개 로드

Go 서버 디버그:
  realtimeLogs: 1000개
  viewportLogs1: 500개 (새로 로드됨)
  viewportLogs2: 0개
  searchResults: 0개
  총계: 1500개

웹 뷰어:
  logsArray: 500개 (스크롤 응답)
  websocketReceived: 500개 (scroll_response)
```

### 검색 시나리오
```
"ERROR" 키워드 검색
→ searchResults에 최대 100개 저장

Go 서버 디버그:
  realtimeLogs: 1000개
  viewportLogs1: 500개
  viewportLogs2: 500개
  searchResults: 45개 (검색 결과)
  총계: 2045개

웹 뷰어:
  logsArray: 45개 (검색 결과만 표시)
  websocketReceived: 45개 (search_response)
```

## 잠재적 차이 원인 분석

### 1. WebSocket 메시지 손실
- **증상**: Go 버퍼 > 웹 뷰어 수신
- **원인**: 네트워크 불안정, 브라우저 재연결, 메시지 큐 오버플로우
- **확인**: WebSocketService.messageCounts와 Go 전송 로그 비교
- **해결**: 메시지 재전송 메커니즘, 연결 상태 모니터링

### 2. 버퍼 상태 불일치
- **증상**: 4-버퍼 총계와 웹 표시 불일치
- **원인**: LRU 교체 시기 차이, 검색 모드 전환
- **확인**: DebugCounts() 호출 시점과 WebSocket 전송 시점 동기화
- **해결**: 버퍼 변경 시 즉시 WebSocket 알림

### 3. JavaScript 렌더링 실패
- **증상**: websocketReceived > displayedCount
- **원인**: DOM 조작 에러, 메모리 부족, 필터링 로직 버그
- **확인**: 브라우저 콘솔 에러 + try-catch 추가
- **해결**: 에러 처리 강화, 메모리 관리 개선

### 4. 메시지 타입 혼동
- **증상**: 중복 카운트 또는 누락
- **원인**: new_log + batch_logs 동시 전송, scroll_response 중복
- **확인**: WebSocketService.handleMessage()에 타입별 로깅
- **해결**: 메시지 타입별 처리 로직 정리

### 5. LRU 캐시 교체
- **증상**: 갑작스러운 카운트 변화
- **원인**: 뷰포트 캐시 교체로 인한 로그 교체
- **확인**: viewport1LastUsed/viewport2LastUsed 타임스탬프 모니터링
- **해결**: 캐시 교체 시 디버그 로그 강화

## 디버깅 절차

### 1. 환경 설정
```bash
# 디버그 모드 활성화
export DEBUG_HYBRID_BUFFER=true

# 클린 빌드
go build .

# 실행
go run . homey-logging --dir ./logs
```

### 2. 실시간 모니터링
```javascript
// 브라우저 콘솔에서 실행
setInterval(() => {
    if (window.logViewer) {
        window.logViewer.updateDebugInfo();
    }
}, 1000);
```

### 3. 로그 분석
- **Go 서버**: HybridLogBuffer.DebugCounts() 출력 확인
- **WebSocket**: messageCounts 객체로 타입별 수신 확인
- **웹 뷰어**: logs.length와 DOM 요소 수 비교
- **타이밍**: 버퍼 변경 → WebSocket 전송 → 웹 수신 순서 확인

### 4. 차이 원인 식별
- **메시지 손실**: WebSocket 연결 로그 분석
- **처리 실패**: 브라우저 개발자 도구 콘솔
- **중복 전송**: messageCounts에서 batch_logs + new_log 합계
- **캐시 교체**: viewportLogs1/2 크기 급변 확인

## 버퍼별 디버깅 팁

### realtimeLogs 디버깅
```go
// 실시간 로그 추가 추적
func (hb *HybridLogBuffer) AddRealtimeLog(entry LogEntry) {
    hb.realtimeLogs = append(hb.realtimeLogs, entry)
    if len(hb.realtimeLogs) > hb.maxRealtimeSize {
        hb.realtimeLogs = hb.realtimeLogs[1:] // FIFO
    }

    util.Log(util.ColorYellow, "[DEBUG] 실시간 로그 추가: %s, 총 %d개\n",
        entry.Message, len(hb.realtimeLogs))
}
```

### 뷰포트 캐시 디버깅
```go
// 캐시 로드 추적
func (hb *HybridLogBuffer) loadViewportCache(viewportIndex int, range ViewportRange) error {
    logs, err := hb.fileStorage.LoadLogsInRange(range.StartID, range.EndID)
    if err != nil {
        return err
    }

    if viewportIndex == 1 {
        hb.viewportLogs1 = logs
        hb.viewport1Range = range
        hb.viewport1LastUsed = time.Now()
    } else {
        hb.viewportLogs2 = logs
        hb.viewport2Range = range
        hb.viewport2LastUsed = time.Now()
    }

    util.Log(util.ColorBlue, "[DEBUG] 뷰포트%d 캐시 로드: %d개 로그 (%d-%d)\n",
        viewportIndex, len(logs), range.StartID, range.EndID)

    return nil
}
```

### 검색 결과 디버깅
```go
// 검색 실행 추적
func (hb *HybridLogBuffer) Search(query string) []LogEntry {
    start := time.Now()

    // 4-버퍼 모두 검색
    results := []LogEntry{}
    results = append(results, hb.searchInBuffer(hb.realtimeLogs, query)...)
    results = append(results, hb.searchInBuffer(hb.viewportLogs1, query)...)
    results = append(results, hb.searchInBuffer(hb.viewportLogs2, query)...)
    results = append(results, hb.searchInFileStorage(query)...)

    // 최대 100개 제한
    if len(results) > 100 {
        results = results[:100]
    }

    hb.searchResults = results
    hb.searchQuery = query
    hb.searchMode = true

    util.Log(util.ColorMagenta, "[DEBUG] 검색 완료: '%s' → %d개 결과 (%v)\n",
        query, len(results), time.Since(start))

    return results
}
```

## 해결 우선순위

1. **WebSocket 연결 안정화**: 재연결 로직 개선
2. **버퍼 상태 동기화**: DebugCounts()와 WebSocket 타이밍 맞춤
3. **JavaScript 에러 처리**: try-catch와 메모리 관리
4. **메시지 타입 정리**: 중복 전송 방지
5. **LRU 캐시 로깅**: 교체 시점 명확히 기록

## 검증 방법

수정 후 다음을 확인:
- 각 버퍼별 카운트가 정확히 일치
- WebSocket 메시지 타입별 카운트 정확성
- 검색 모드 전환 시 상태 일관성
- 스크롤 시 뷰포트 캐시 교체 정확성
- 메모리 사용량이 안정적 유지

## 관련 파일

- `lib/log-viewer/hybrid_log_buffer.go`: HybridLogBuffer 구현
- `lib/log-viewer/js/modules/LogViewer.js`: 웹 로그 표시
- `lib/log-viewer/js/modules/WebSocketService.js`: WebSocket 통신
- `lib/log-viewer/log_viewer.go`: WebLogViewer 서버
4. **타이밍 동기화**: 완료 이벤트 정확한 타이밍

## 검증 방법

수정 후 다음을 확인:
- Go 서버와 웹 뷰어 로그 수가 정확히 일치
- 여러 번 실행해도 일관성 유지
- WebSocket 연결 끊김/재연결 시에도 정확성 유지
- 필터링 적용 시에도 카운트 정확성 유지

## 관련 파일

- `main.go`: Go 서버 디버그 로그
- `lib/log-viewer/js/modules/LogViewer.js`: 웹 뷰어 실제 카운트
- `lib/log-viewer/js/modules/WebSocketService.js`: 메시지 전송/수신 로그
- `lib/log-viewer/log_viewer.go`: WebSocket 브로드캐스트 로그
