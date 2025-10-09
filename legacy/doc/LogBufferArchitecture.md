# 로그 버퍼링 시스템 아키텍처 (4-버퍼 하이브리드 시스템)

## 개요

Edge Tool의 로그 처리 시스템은 **4-버퍼 하이브리드 아키텍처**를 기반으로 실시간 로그 모니터링부터 대용량 로그 분석까지 지원합니다. 메모리 기반 실시간 처리와 파일 기반 영구 저장을 결합한 최적화된 시스템입니다.

## 4-버퍼 아키텍처 구성 요소

### 1. 버퍼 구조

#### HybridLogBuffer (핵심 버퍼 시스템)
```go
type HybridLogBuffer struct {
    // 4-버퍼 시스템
    realtimeLogs    []LogEntry    // 실시간 로그 (최신 1000개)
    viewportLogs1   []LogEntry    // 뷰포트 캐시1 (500개)
    viewportLogs2   []LogEntry    // 뷰포트 캐시2 (500개)
    searchResults   []LogEntry    // 검색 결과 버퍼 (100개)

    // LRU 캐시 관리
    viewport1Range     ViewportRange
    viewport2Range     ViewportRange
    viewport1LastUsed  time.Time
    viewport2LastUsed  time.Time

    // 파일 저장소 연동
    fileStorage     *LogFileStorage

    // 검색 상태 관리
    searchQuery     string
    searchMode      bool
    searchHash      string

    // 입력 소스 추적
    inputSources    map[string]InputSource
}
```

### 2. 뷰포트 범위 관리

#### ViewportRange 구조체
```go
type ViewportRange struct {
    StartID     int64     // 시작 로그 ID
    EndID       int64     // 종료 로그 ID
    StartTime   time.Time // 시작 시간
    EndTime     time.Time // 종료 시간
    FileCount   int       // 포함된 파일 수
    TotalLogs   int64     // 총 로그 수
}
```

**역할**: 뷰포트 캐시의 범위 정보를 추적하여 효율적인 캐시 히트/미스 판단

### 3. 파일 저장소 시스템

#### LogFileStorage 구조체
```go
type LogFileStorage struct {
    LogsDirectory string
    IndexFile     string
    MaxFileSize   int64
    Compression   bool
    Timezone      *time.Location
}
```

**역할**: 대용량 로그의 파일 시스템 저장 및 효율적인 범위 조회 지원

## 데이터 흐름 아키텍처

### 전체 데이터 흐름 다이어그램
```
호스트 실시간 로그 스트림 (ADB/SSH)           로컬 로그 파일들 (*.log/*.jsonl)
    ↓ (stdout/stderr)                              ↓
LogBufferWriter ── 파싱 및 필터링 ──→ HybridLogBuffer → WebSocket Server ──→ 브라우저
    ↓                                           ↓
LogFileIntegration ── 통합 및 정렬 ──→ HybridLogBuffer ──────────────────────┘
    ↓
LogFileStorage ←── 영구 저장 ──→ 파일 시스템 (JSONL 포맷)
```

### 버퍼별 데이터 흐름

#### 1. 실시간 로그 경로 (realtimeLogs)
```
Homey 디바이스 → ADB/SSH → LogBufferWriter → realtimeLogs → WebSocket 스트리밍
(journalctl -f 등)     (실시간 파싱)     (메모리 저장)    (즉시 전송)
```

#### 2. 뷰포트 캐시 경로 (viewportLogs1/2)
```
사용자 스크롤 → 범위 계산 → 캐시 히트 확인 → viewportLogs → WebSocket
    ↓ (미스 시)                              ↓
LogFileStorage → 파일 로드 → LRU 교체 → viewportLogs
```

#### 3. 검색 결과 경로 (searchResults)
```
검색 요청 → 실시간+파일 검색 → searchResults → WebSocket
    ↓
LogFileStorage (인덱스 활용)
```

## 4-버퍼 관리 전략

### 버퍼별 역할 분담

| 버퍼 | 용도 | 크기 | 저장 방식 | 갱신 주기 |
|------|------|------|----------|-----------|
| **realtimeLogs** | 최신 로그 모니터링 | 1000개 | 메모리 | 실시간 |
| **viewportLogs1** | 스크롤 캐시1 | 500개 | 메모리 | LRU |
| **viewportLogs2** | 스크롤 캐시2 | 500개 | 메모리 | LRU |
| **searchResults** | 검색 결과 | 100개 | 메모리 | 검색 시 |

### LRU 캐시 알고리즘

#### 뷰포트 선택 로직
```go
func (hb *HybridLogBuffer) selectLRUViewport() int {
    if hb.viewport1LastUsed.Before(hb.viewport2LastUsed) {
        return 1 // viewport1이 더 오래됨
    }
    return 2 // viewport2가 더 오래됨
}
```

#### 캐시 갱신 프로세스
```
새 범위 요청 → LRU 뷰포트 선택 → 파일에서 로드 → 기존 캐시 교체 → 타임스탬프 갱신
```

### 메모리 최적화

#### 총 메모리 사용량
- **실시간 버퍼**: 1000개 로그 (~200KB)
- **뷰포트 버퍼**: 500개 × 2 = 1000개 로그 (~200KB)
- **검색 버퍼**: 100개 로그 (~20KB)
- **합계**: ~420KB (기존 대비 2배, 용량 대비 50배 효율)

#### 캐시 히트율 목표
- **실시간 영역**: 100% (항상 메모리)
- **뷰포트 캐시**: 85-90% (사용자 패턴 기반)
- **전체 히트율**: 95% 이상

## 입력 소스 통합

### 입력 어댑터 계층

#### LogBufferWriter (실시간 로그용)
```go
type LogBufferWriter struct {
    logType     string
    logBuffer   *HybridLogBuffer
    filter      string
    sourceID    string // 입력 소스 식별자
}
```

#### LogFileIntegration (파일 로그용)
```go
type LogFileIntegration struct {
    LogTypes   map[string]*LogTypeData
    MainBuffer *HybridLogBuffer
    Timezone   *time.Location
}
```

### 입력 소스 추적
```go
type InputSource struct {
    Type        string    // "host_realtime", "file_batch"
    Identifier  string    // 호스트 ID 또는 파일 경로
    StartTime   time.Time // 입력 시작 시간
    TotalLogs   int64     // 총 로그 수
    Status      string    // "active", "completed", "error"
    LastUpdate  time.Time // 마지막 갱신 시간
}
```

## 검색 아키텍처

### 통합 검색 전략
- **검색 대상**: realtimeLogs + viewportLogs1/2 + LogFileStorage
- **검색 방식**: 단순 contains 매칭 (대소문자 무시)
- **결과 제한**: 최대 100개 (searchResults 버퍼 크기)
- **성능 최적화**: 파일 검색 시 인덱스 활용

### 검색 프로세스
```
1. searchResults 버퍼 초기화
2. realtimeLogs에서 검색 (메모리)
3. viewportLogs1/2에서 검색 (메모리)
4. LogFileStorage에서 검색 (파일 + 인덱스)
5. 결과 통합 및 정렬 (최대 100개)
6. WebSocket으로 결과 전송
```

## 파일 저장소 연동

### LogFileStorage 세부 기능

#### 범위 기반 로드
```go
func (lfs *LogFileStorage) LoadLogsInRange(startID, endID int64) []LogEntry
```
- 멀티파일에 걸친 범위 조회 지원
- 자동 정렬 및 중복 제거
- 청크 단위 로드로 메모리 효율성 확보

#### 타임존 보정
```go
func (lfi *LogFileIntegration) adjustTimezone(entry *LogEntry) {
    // 로그 타임스탬프를 로컬 타임존으로 보정
    if entry.Timestamp.IsZero() {
        entry.Timestamp = time.Now()
    }
    entry.Timestamp = entry.Timestamp.In(lfi.Timezone)
}
```

#### 파일 포맷 지원
- **JSONL**: 구조화된 로그 저장
- **압축**: 선택적 gzip 압축
- **청크**: 대용량 파일을 작은 단위로 분할

## WebSocket 프로토콜 확장

### 새로운 메시지 타입

#### 스크롤 요청/응답
```javascript
// 요청
{
    "type": "scroll_request",
    "scroll_top": 1200.5,
    "viewport_height": 800,
    "total_height": 50000
}

// 응답
{
    "type": "scroll_response",
    "logs": [...],
    "count": 500,
    "has_more": false
}
```

#### 검색 요청/응답
```javascript
// 요청
{
    "type": "search_request",
    "keyword": "ERROR",
    "case_sensitive": false
}

// 응답
{
    "type": "search_response",
    "keyword": "ERROR",
    "results": [...],
    "count": 45,
    "total_matches": 1250
}
```

## 성능 최적화 전략

### 메모리 관리
- **LRU 캐시**: 뷰포트 교체 시 가장 오래된 캐시 우선 선택
- **범위 추적**: ViewportRange로 효율적인 히트/미스 판단
- **자동 정리**: 실시간 버퍼 FIFO 방식으로 오래된 로그 제거

### I/O 최적화
- **청크 로드**: 대용량 파일을 작은 단위로 분할 로드
- **비동기 처리**: Go goroutine으로 블로킹 방지
- **인덱스 활용**: 검색 시 파일 인덱스로 빠른 접근

### 네트워크 최적화
- **배치 전송**: WebSocket으로 다량 로그 배치 전송
- **증분 업데이트**: 실시간 로그만 즉시 전송
- **압축 전송**: 선택적 메시지 압축

## 확장성 및 유지보수

### 인터페이스 기반 설계
```go
type LogBufferInterface interface {
    AddLog(entry LogEntry) error
    GetLogsInRange(startID, endID int64) []LogEntry
    SearchLogs(query string) []LogEntry
    GetViewportLogs(scrollPos float64) []LogEntry
    Close() error
}
```

### 모듈화 원칙
- **독립적 책임**: 각 컴포넌트가 명확한 역할
- **느슨한 결합**: 인터페이스와 이벤트 기반 통신
- **테스트 용이성**: 각 모듈 독립적 단위 테스트

### 모니터링 및 디버깅
- **버퍼 상태 추적**: 각 버퍼의 사용량 및 히트율 모니터링
- **성능 메트릭**: 응답 시간, 메모리 사용량 수집
- **에러 로깅**: 상세한 에러 정보와 복구 전략

## 결론

**4-버퍼 하이브리드 아키텍처**는 실시간 로그 모니터링과 대용량 로그 분석을 모두 지원하는 최적화된 솔루션입니다.

### 핵심 강점
- **실시간 성능**: 메모리 기반 즉시 응답
- **대용량 지원**: 파일 시스템 연동으로 무제한 확장
- **지능적 캐싱**: LRU 기반 뷰포트 캐시로 최적 성능
- **통합 검색**: 모든 버퍼와 파일 대상 검색
- **모듈러 설계**: 확장과 유지보수가 용이

### 데이터 흐름 요약
```
모든 입력 → 어댑터 → 4-버퍼 시스템 → WebSocket → 웹 UI
(실시간/파일)    (파싱)    (메모리+파일)    (스트리밍)    (표시)
```

이 아키텍처는 코드의 실제 구현과 완전히 동기화되어 있으며, 지속적인 최적화와 확장을 지원합니다.
```
