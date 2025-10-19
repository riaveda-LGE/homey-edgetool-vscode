# Logging 1: 데이터 준비 (실시간 모드 / 파일 병합 모드)

## 📁 관련 파일
```bash
src/core/connection/ConnectionManager.ts
src/core/logs/LogFileIntegration.ts
src/core/logging/extension-logger.ts
src/extension/commands/CommandHandlersLogging.ts
src/extension/panels/LogViewerPanelManager.ts
```

## 🔄 로직 플로우

### 실시간 로그 준비
- **연결 관리**: `ConnectionManager`가 SSH/ADB 연결 설정
- **스트림 시작**: `tail -f`, `journalctl -f`, `dmesg -w` 명령 실행
- **라인 수집**: stdout을 실시간으로 LogEntry 변환
- **필터 적용**: 실시간 스트림에 PID/텍스트 필터 적용
- **취소 처리**: AbortController로 프로세스 kill 및 정리

### 파일 병합 준비
- **파일 스캔**: `listInputLogFiles()`로 .log/.log.N 파일 수집
- **타입 그룹화**: `groupByType()`으로 파일명 기반 분류
- **워밍업 선행**: `warmupTailPrepass()`로 초기 N줄 빠른 로딩
- **타임존 보정**: `TimezoneCorrector`로 시차 자동 조정
- **k-way 병합**: `MaxHeap`으로 최신순 정렬 병합

### 로깅 인프라
- **콘솔 패치**: `console.*` 함수들을 OutputChannel로 리다이렉션
- **키워드 필터링**: `LOG_IGNORE_KEYWORDS`로 불필요 로그 제외
- **메모리 버퍼링**: `LOG_MAX_BUFFER` 크기로 최근 로그 유지
- **싱크 관리**: `addSink/removeSink`로 다중 출력 지원

### 명령 처리
- **UI 트리거**: `openHomeyLogging()` 명령으로 패널 열기
- **세션 시작**: `startRealtimeSession()` 또는 `startFileMergeSession()`
- **상태 관리**: 모드별(realtime/filemerge) 상태 추적
