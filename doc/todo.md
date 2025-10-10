P0 — 오늘 바로 고치기 (빌드/런타임 안정화)

 타입 전용 import 정리

웹뷰/호스트에서 타입만 쓰는 import는 전부 import type로 교정 (verbatimModuleSyntax: true 때문)

 nonce 생성 버그 수정

extension/panels/extensionPanel.ts → getNonce() 구현을 일반적인 랜덤 인덱스로 수정

function getNonce() {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}


 한글 주석/문자 깨짐(모지바케) 정리

src/** 전체에 퍼져있는 깨진 문자열(예: ?낅뜲?댄듃) 삭제/정상화

저장 인코딩을 UTF-8로 강제(에디터 설정 또는 .editorconfig 추가)

 패널 리소스 경로/옵션 확인

EdgePanelProvider에서 localResourceRoots에 media/edge-panel 포함 ✅ (지금 OK)

CSP 치환 토큰(%CSS_URI%, %JS_URI%, %NONCE%, %CSP_SOURCE%)이 HTML에 정확히 들어가는지 확인

 공유 상수 정의 확인

src/shared/const.ts의 EXTENSION_PUBLISHER 주석과 코드가 한 줄에 겹쳐 보임 → 실제 코드에선 주석과 코드 분리되어 있는지 확인

EXTENSION_ID가 올바로 계산되는지 빌드 시 에러 체크

 log viewer webview 초기 핸드셋

src/ui/log-viewer/app.ts에서 acquireVsCodeApi 유무 분기 이미 있음 → 초기 ui.ready 발신 OK

messageTypes의 Envelope 규격(v:1)과 맞게 전송/수신 형식 재확인

P1 — 최소 기능(MVP) 수립
1) 명령 라우팅/콘솔 일원화

 extension/commands/registerCommands.ts 생성: hello, updateNow 외 edge 콘솔 입력을 명령으로 라우팅하는 공용 API 등록

 extension/commands/commandHandlers.ts 생성:

help/h, connect_info, connect_change, homey-logging, homey-logging --dir <path>, homey-logging --stop, homey-restart, homey-mount/unmount, git pull/push, host <cmd>, shell 등 스텁 → 점진 구현

 EdgePanelProvider의 onDidReceiveMessage({command:'run'}) → commandHandlers 호출로 분리(테스트 용이)

2) 연결/실행 계층

 core/connection/ExecRunner.ts 추가

Windows: PowerShell, POSIX: /bin/sh -c 표준화

옵션: timeoutMs, signal, onStdout, onStderr

 adapters/ssh/sshClient.ts (최소한의 래퍼)

ssh 바이너리 호출 옵션 구성(호스트/포트/키/비번)

run(cmd, {stdin}), stream(cmd, handlers) 제공

 adapters/adb/adbClient.ts (선택 사용)

adb -s <serial> shell "<cmd>" 공통 래퍼

 core/connection/ConnectionManager.ts 실제 구현

현재 스텁 run()을 ExecRunner + ssh/adbClient로 연결

connect(), dispose()에서 세션 상태 로깅

3) 실시간 로그 스트리밍

 core/sessions/LogSessionManager.ts의 startRealtimeSession()을 실제 구현

SSH/ADB tail -f 또는 journalctl -f 등 소스 선택

라인 버퍼링 → HybridLogBuffer.add() → 브리지 onBatch 호출 주기화(예: 50줄/100ms)

AbortSignal 취소 시 하위 프로세스 종료 보장

4) 파일 병합 모드(스텁 → 최소 동작)

 core/logs/LogFileIntegration.ts 생성(최소 동작)

입력: 디렉터리(패턴), 여러 파일을 읽어 타임스탬프 기준 정렬 후 배치로 방출

1차는 정방향 또는 역방향 중 하나만 지원해도 OK

LogSessionManager.startFileMergeSession()에서 호출

5) 파일 전송(스텁 → 인터페이스 고정)

 core/transfer/FileTransferService.ts

인터페이스는 유지, 내부 로직은 TODO 주석 + 예외 분류/로깅까지 작성

실제 구현은 P2에서

P2 — 기능 고도화(안정성/UX)
6) tar/base64 over SSH 전송 본 구현

 업로드: tar -cf - <local> | base64 | ssh "base64 -d | tar -xf - -C <remote>"

 다운로드: ssh "tar -cf - <remote> | base64" | base64 -d > tmp.tar && tar -xf tmp.tar -C <local>

 에러/타임아웃/권한/경로 검증, 임시파일 정리, AbortSignal 전파

 진행률 콜백(가능하면 라인 기준/바이트 기준 추정치 제공)

7) K-way 병합 + 타임존 보정

 LogFileIntegration에 우선순위 큐 기반 k-way merge 추가

 로그 라인 파서(타임스탬프 추출, 포맷 다변화), 타임존 점프 감지/보정(옵션)

8) HybridLogBuffer 4-버퍼 구조 확장

 현재 realtime만 존재 → viewport/search/spill 추가

 getMetrics() 반환 확장 + Panel에서 간단 시각 표시

 최대 줄 수/메모리 상한 관리(오래된 spill 정리)

9) Webview UX 개선

 media/edge-panel/panel.js → TS로 이관(panel.ts) 및 번들

 검색/필터/하이라이트 초안: Ctrl+F, 토글 버튼

 자동 스크롤 규칙(하단 5% 이내일 때만)

10) 메시지 브리지 단일화

 HostWebviewBridge 사용을 Panel도 적극 활용(지금은 postMessage 혼용)

ui.ready → logs.batch/metrics.update/error 등 **모두 Envelope 규격(v:1)**로 통일

11) 설정 스키마/컨트리뷰션

 package.json > contributes.configuration에 아래 추가

homeyEdgetool.connection(ssh/adb, host/user/key/path)

homeyEdgetool.logs(버퍼 크기, 전송 배치, 색상/필터)

homeyEdgetool.timeouts(ssh/adb/tar 단계별 ms)

 core/config/schema.ts로 타입 안전 스키마와 기본값 제공

12) 성능 로깅/계측

 core/logging/perf.ts 추가: withPerf(name, fn), perfNow()

 주요 경로(병합, 전송, 스트림)에 계측 삽입 → Panel에서 metrics.update로 표출

P3 — 품질·개발편의

 번들러 도입(esbuild 권장)

webview/ TS → 단일 JS로 출력, asWebviewUri로 참조

워치 모드(npm run dev) + HMR(옵션)

 테스트 스크립트 정비

scripts/perf/stream-simulator.ts 추가(모의 로그 스트림)

run-merge-bench.ts에 실제 파일 셋 기반 벤치

 에러 표준화

shared/errors.ts: 카테고리(enum) + toDisplayMessage()

브리지 sendError()는 코드/메시지 일관되게

 문서화/README

설치/개발 워크플로우, 설정 가이드, 명령 레퍼런스