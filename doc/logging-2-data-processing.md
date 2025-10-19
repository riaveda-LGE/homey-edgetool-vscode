# Logging 2: 데이터 처리 및 버퍼링 (코어 로직)

## 📁 관련 파일
```bash
src/core/logs/LogFileStorage.ts
src/core/logs/HybridLogBuffer.ts
src/core/logs/PaginationService.ts
src/core/logging/perf.ts
src/core/sessions/LogSessionManager.ts
```

## 🔄 로직 플로우

### JSONL 저장소 관리
- **데이터 저장**: `append()`로 LogEntry를 JSONL 라인으로 저장
- **범위 조회**: `range()`로 시간 기반 구간 읽기 (fromTs/toTs)
- **안전 파싱**: `safeParseJson()`으로 손상 라인 스킵
- **플러시 제어**: `flush` 옵션으로 즉시/버퍼링 저장 선택

### 버퍼 시스템
- **실시간 버퍼**: `HybridLogBuffer`의 realtime 배열 (현재 구현)
- **미래 확장**: viewport/search/spill 버퍼 준비 (LRU/ARC 기반)
- **메모리 관리**: `REALTIME_BUFFER_MAX`로 크기 제한
- **메트릭 제공**: `getMetrics()`로 버퍼 상태 모니터링

### 페이지네이션
- **가상 총계**: `virtualTotal`로 예상 전체 크기 관리
- **윈도우 관리**: `windowStart/windowSize`로 표시 범위 제어
- **필터 적용**: PID/src/proc/msg 필드로 서버측 필터링
- **캐시 관리**: `filteredTotalCache`로 계산 결과 캐싱

### 성능 모니터링
- **함수 측정**: `@measure` 데코레이터로 실행 시간 기록
- **I/O 측정**: `@measureIO` 데코레이터로 파일 작업 성능 측정
- **On/Off 제어**: `PerformanceProfiler.isEnabled`로 오버헤드 제로 모드
- **싱글톤 관리**: 전역 `globalProfiler`로 설정 공유

### 세션 오케스트레이션
- **병합 세션**: `startFileMergeSession()`으로 T0/T1 단계 관리
- **실시간 세션**: `startRealtimeSession()`으로 지속 스트림 처리
- **배치 전송**: `onBatch` 콜백으로 UI에 데이터 공급
- **진행률 보고**: `onProgress`로 병합 상태 알림
