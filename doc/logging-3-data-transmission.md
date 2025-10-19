# Logging 3: 데이터 전송 및 IPC (호스트 ↔ 웹뷰어)

## 📁 관련 파일
- `src/extension/messaging/hostWebviewBridge.ts`
- `src/shared/ipc/messages.ts`
- `src/core/logs/LogSearch.ts`
- `src/extension/panels/LogViewerPanelManager.ts`

## 🔄 로직 플로우

### 최적화 전송 전략
- **배치 전송**: 32-128KB 단위로 로그 묶어 전송
- **ACK 백프레셔**: Webview ACK 응답 전 전송 제한 (in-flight 1-2개)
- **초기 스냅샷**: 최근 N줄을 한 번에 전송
- **실시간 스트리밍**: 이후 새 로그를 지속 배치 전송
- **압축 적용**: 대용량 시 gzip → base64 인코딩

### IPC 메시지 플로우
- **로그 배치**: `logs.batch` (len/total/seq + LogEntry[])
- **병합 진행**: `merge.progress` (done/total + percent)
- **필터 적용**: `filter.apply` (PID/src/proc/msg 필터 전송)
- **검색 요청**: `search.query` (q/regex/range/top 파라미터)
- **범위 요청**: `logs.requestRange` (스크롤 시 추가 데이터)

### 고급 검색 처리
- **다중 필드 매칭**: PID/파일/프로세스/메시지 부분일치
- **정규식 지원**: `regex` 플래그로 패턴 검색
- **시간 범위**: `range` [from,to]로 기간 필터링
- **결과 제한**: `top`으로 최대 반환 개수 제어
- **파싱 규칙**: `parseLine()`으로 syslog 형식 분석

### 브리지 관리
- **메시지 라우팅**: Host ↔ Webview 양방향 이벤트 처리
- **에러 처리**: `postMessage` 실패 시 재시도 로직
- **상태 동기화**: Webview 준비 완료까지 버퍼링
- **메모리 관리**: 대용량 메시지 청크 분할 전송
