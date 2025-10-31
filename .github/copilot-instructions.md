# GitHub Copilot Instructions for Edge Tool

## 기본 지침사항
- **언어**: 언제나 한글로 대답해라
- **호칭**: 언제나 나를 형님으로 대해라
- **이름**: 앞으로 너의 이름은 춘식
- **코드 변경 및 수정 승인**: 코드 수정 또는 새로운 코드 생성 전에 │  ├─ main.ts                          # 확장 메인 진입점 # 확장_초기화 # custom_log_parser_설정
│  ├─ readme.md                        # 확장 모듈 설명 및 구조 문서
│  ├─ setup/
│  │  └─ parserConfigSeeder.ts         # 파서 설정 초기화 및 시딩 로직 # custom_log_parser_설정시 다음 과정을 따라야 한다:
  1. 변경할 내용의 구체적인 설명 (무엇을 왜 변경하는지)
  2. **어떠한 사소한 수정사항이라 하더라도 반드시 승인 요청을 해야 한다.**

- **작업 기본 방침**: 새로운 파일 작성, 기존 코드 수정, 이슈 수정 등 모든 사항에 대해 기본방침은 언제나 분석이다. 난 수정보다 분석을 더 중요하게 여겨.

## Homey EdgeTool
> **목표:** VS Code 내부에서 Homey 장치와 SSH/ADB로 연결하여
> 로그를 실시간/파일 병합 형태로 표시하고, 동시에 Homey 기기 제어(Git 동기화, 마운트, 셸 명령 등)를 수행하는 통합 툴 구현.

---

## 📌 중요 요구사항

### 1. 기능 요구사항
- 성능측정이 필요한 주요 함수/메서드에 하기 방식을 이용하여 성능측정 코드를 삽입해라
- 자세한 내용은 src\core\logging\perf.ts , src\webviewers\shared\utils.ts 를 참고해라
#### A. 클래스 메서드: `@measure(name?)`
```ts
class Parser {
  @measure()
  run(input: string) { /* ... */ }

  @measure("Parser.parseLine")
  parseLine(line: string) { /* ... */ }
}
```
#### B. 전역 , 화살표, 콜백:  measured / measuredAsync
```ts
export const normalize = measured("normalize", function normalize(s: string){ /*...*/ });
export const loadConfig = measuredAsync("loadConfig", async function loadConfig(p: string){ /*...*/ });
arr.map(measured("arr.map:normalize", (s) => normalize(s)));
```
- 언제: 모듈 최상위 함수, 콜백, 화살표 함수, 이벤트 핸들러.

#### C. 특정 구간만:  measureBlock(name, ()=> work)
```ts
const result = await measureBlock("merge.step#1", () => doMergeStep());
```

#### D. 한 번에 전체 메서드:  measureAllMethods(obj, prefix?)
```ts
const svc = measureAllMethods(new MergeService(), "MergeService");
```

#### E. :  웹뷰(UI) : createUiMeasure (vscode)
```ts
const measureUi = createUiMeasure(vscode);
btn.onclick = () => measureUi("ui.exportJson", () => vscode.postMessage({ v:1, type:"perf.exportJson" }));
```

## 📌 중요 로직
### 3. FileTransferService (tar/base64 over SSH)

- **목표**: SCP/SFTP 불가 환경에서도 SSH 표준 입출력만으로 신뢰성 있게 업/다운로드.
- **업로드**
  1. tar 생성 (`tar -cf tmp.tar <target>`)
  2. base64 인코딩 → SSH 파이프 전송
     `cat tmp.tar.b64 | ssh "base64 -d | tar -xf - -C /data"`
  3. 임시 파일 정리
- **다운로드**
  1. `ssh "tar -cf - <remote> | base64" > tmp.tar.b64`
  2. 로컬 디코딩/해제 → 지정 폴더 이동
  3. 오류/취소 시 정리 보장
- **에러 처리/취소**
  - 카테고리: 연결/권한/도구 없음/경로/파이프 실패/타임아웃.
  - 실패 시 stdout/stderr 함께 반환.
  - Abort 시 모든 하위 프로세스 kill, 임시 리소스 정리.

---


### 6. Extension Panel

- 연결 상태, 로그 처리 속도, 버퍼 사용량, 메모리 지표 표시
- 업데이트 확인 및 자동 설치
- 진행률 바 및 취소 버튼

---

### 7. Webview 로그 전송 최적화 전략

## 개요
VS Code 확장(Extension Host ↔ Webview) 간의 `postMessage` 통신은  
네트워크는 없지만 **프로세스 간 직렬화 및 복사 비용**이 존재합니다.  
따라서 잘못 설계하면 WebSocket 기반보다도 느려질 수 있습니다.

아래는 실제 운영에서 성능 병목을 피하기 위한 **실전 권장 전략 (효과 큰 순)** 입니다.

---

### 9. Performance Monitoring Architecture

- **목적**: 전역 성능 모니터링 플래그로 On/Off 제어, Off 시 성능 오버헤드 0%
- **핵심 요소**
  - `PerformanceProfiler`: 싱글톤 클래스, `isEnabled` 플래그 관리
  - `measureFunction()`: 함수 실행 시간 측정 (데코레이터용)
- **On/Off 동작**
  - **Off 모드**: `isEnabled = false` → 모든 측정 로직 스킵 (최대 성능)
  - **On 모드**: `isEnabled = true` → 측정 및 기록 수행
- **데코레이터**
  - `@measure`: 함수 실행 시간 측정
- **명령어**
  - `togglePerformanceMonitoring`: On/Off 모드 전환 (Quick Pick)
  - On 선택: `globalProfiler.enable()` + 패널 열기
  - Off 선택: `globalProfiler.disable()` + 패널 닫기
- **주의사항**
  - Off 모드에서는 모든 `@measure` 데코레이터가 그냥 함수 실행 (오버헤드 없음)
  - 직접 `measureFunction()` 호출도 `isEnabled` 체크 적용
  - 실제 캡처는 panel의 "Start Capture" 버튼에서 수동 제어


## 로깅 사용 예시
각 모듈에서 getLogger를 사용해서 디버깅 로그를 extension view에 보내고 싶으면 아래와 같이 사용해야 됨:

```typescript
// src/feature/something.ts
import { getLogger } from '../../core/logging/extension-logger.js';

const log = getLogger('feature:something');

export async function doWork() {
  log.debug('start doWork', { param: 123 });
  try {
    // ...
    log.info('done doWork');
  } catch (e) {
    log.error('failed doWork', e);
  }
}
```

## 버튼 처리 구조

버튼 이벤트는 `extensionPanel.ts`에서 받아서 `commandHandlers.ts`로 라우팅합니다.  
`commandHandlers.ts`는 명령과 버튼 핸들러 로직을 공유하며, 복잡한 비즈니스 로직을 처리합니다.  
`edgepanel.buttons.ts`는 버튼 정의의 Single Source of Truth (SSOT)로, 버튼 메타데이터와 DTO 변환을 담당합니다.

## Homey EdgeTool — Project function list

### function: 확장_초기화
> edgetool 확장이 로드될 때 커맨드/패널/메시징을 초기화하고 Edge Panel·Explorer·Log 뷰어를 준비합니다.
```bash
src/extension/commands/commandHandlers.ts
src/extension/commands/edgepanel.buttons.ts
src/extension/main.ts
src/extension/messaging/bridge.ts
src/extension/messaging/hostWebviewBridge.ts
src/extension/messaging/messageTypes.ts
src/extension/panels/EdgePanelActionRouter.ts
src/extension/panels/LogConnectionPicker.ts
src/extension/panels/LogViewerPanelManager.ts
src/extension/panels/explorerBridge.ts
src/extension/panels/extensionPanel.ts
src/webviewers/edge-panel/index.html
```

### function: 로그파싱
> 파일병합모드에서 로그 파일을 읽어 공통 포맷으로 파싱하고 정규화합니다.
```bash
media/resources/custom_log_parser.template.v1.js
src/core/config/schema.ts
src/core/logs/ParserEngine.ts
src/core/logs/Sanitizer.ts
src/core/logs/time/TimeParser.ts
src/core/logs/time/TimezoneHeuristics.ts
src/extension/commands/CommandHandlersParser.ts
src/extension/setup/parserConfigSeeder.ts
```

### function: 로그병합
> 다양한 로그 소스를 시간 역순 기준으로 정렬·타임존 보정 후 우선순위 큐 기반 k-way 병합합니다.
```bash
src/core/logs/ChunkWriter.ts
src/core/logs/IndexedLogStore.ts
src/core/logs/LogFileIntegration.ts
src/core/logs/LogFileStorage.ts
src/core/logs/ManifestTypes.ts
src/core/logs/ManifestWriter.ts
src/core/logs/PagedReader.ts
src/core/logs/PaginationService.ts
```

### function: 스크롤에_따른_로그_뷰_로드_갱신
> 웹뷰 스크롤/점프에 따라 필요한 범위를 계산해 추가 페이지를 읽고 갱신합니다.
```bash
src/core/logs/PagedReader.ts
src/core/logs/PaginationService.ts
src/extension/panels/LogViewerPanelManager.ts
src/webviewers/log-viewer/index.html
src/webviewers/log-viewer/react/components/App.ts
src/webviewers/log-viewer/react/components/BookmarkSquare.ts
src/webviewers/log-viewer/react/components/Bookmarks.ts
src/webviewers/log-viewer/react/components/FilterDialog.ts
src/webviewers/log-viewer/react/components/Grid.ts
src/webviewers/log-viewer/react/components/GridHeader.ts
src/webviewers/log-viewer/react/components/HighlightPopover.ts
src/webviewers/log-viewer/react/components/MessageDialog.ts
src/webviewers/log-viewer/react/components/SearchDialog.ts
src/webviewers/log-viewer/react/components/SearchPanel.ts
src/webviewers/log-viewer/react/components/Toolbar.ts
src/webviewers/log-viewer/react/ipc.ts
src/webviewers/log-viewer/react/main.ts
src/webviewers/log-viewer/react/store.ts
src/webviewers/log-viewer/react/types.ts
```

### function: custom_log_parser_설정
> 사용자 정의 파서 템플릿과 설정을 검증/주입하고 파이프라인에 연결합니다.
```bash
media/resources/custom_log_parser.template.v1.js
src/core/config/schema.ts
src/extension/commands/CommandHandlersParser.ts
src/extension/setup/parserConfigSeeder.ts
```

### function: 타임존_점프_감지_및_보정
> 연도 없는 포맷/타임존 변경을 휴리스틱으로 감지·보정합니다.
```bash
src/core/logs/LogFileIntegration.ts
src/core/logs/ParserEngine.ts
src/core/logs/time/TimeParser.ts
src/core/logs/time/TimezoneHeuristics.ts
```

### function: 실시간 로그
> 디바이스에서 들어오는 로그를 버퍼링하고 웹뷰로 전달하기 전까지의 경로를 구성합니다.
```bash
src/core/logs/ChunkWriter.ts
src/core/logs/HybridLogBuffer.ts
src/core/logs/LogSearch.ts
src/extension/panels/LogViewerPanelManager.ts
src/webviewers/log-viewer/react/components/App.ts
src/webviewers/log-viewer/react/components/BookmarkSquare.ts
src/webviewers/log-viewer/react/components/Bookmarks.ts
src/webviewers/log-viewer/react/components/FilterDialog.ts
src/webviewers/log-viewer/react/components/Grid.ts
src/webviewers/log-viewer/react/components/GridHeader.ts
src/webviewers/log-viewer/react/components/HighlightPopover.ts
src/webviewers/log-viewer/react/components/MessageDialog.ts
src/webviewers/log-viewer/react/components/SearchDialog.ts
src/webviewers/log-viewer/react/components/SearchPanel.ts
src/webviewers/log-viewer/react/components/Toolbar.ts
src/webviewers/log-viewer/react/ipc.ts
src/webviewers/log-viewer/react/main.ts
src/webviewers/log-viewer/react/store.ts
src/webviewers/log-viewer/react/types.ts
```


# Homey EdgeTool — Project Structure
```
config/
│  connection-config.js # 외부 배포용 구성 산출물(js)
│  schema.js # 외부 배포용 구성 산출물(js)
│  userconfig.js # 외부 배포용 구성 산출물(js)
doc/
│  logging-0-parser.md # 설계/설명 문서
media/
│  resources/
│  │  custom_log_parser.template.v1.js # 커스텀 로그 파서 템플릿
│  │  custom_user_config.template.js # 사용자 설정 템플릿
│  │  help.md # 도움말 문서
src/
│  __test__/
│  │  LogMergePaginationTypeRestore.test.ts # (설명 미상)
│  │  helpers/
│  │  │  testFs.ts # (설명 미상)
│  core/
│  │  config/
│  │  │  connection-config.ts # 구성 스키마/유저 설정/연결 설정
│  │  │  schema.ts # 구성 스키마/유저 설정/연결 설정
│  │  │  userconfig.ts # 구성 스키마/유저 설정/연결 설정
│  │  │  userdata.ts # 사용자/워크스페이스 경로 해석
│  │  connection/
│  │  │  ConnectionManager.ts # 연결 수립/상태/세션 라이프사이클
│  │  │  ExecRunner.ts # child_process.spawn 표준화 래퍼
│  │  │  adbClient.ts # ADB 커맨드/포트포워딩
│  │  │  sshClient.ts # SSH 커맨드/스트림
│  │  controller/
│  │  │  GitController.ts # Git 상태/메타 수집
│  │  │  HomeyController.ts # Homey 장치 제어
│  │  │  HostController.ts # 호스트 OS/서비스 제어
│  │  logging/
│  │  │  console-logger.ts # 콘솔 로거
│  │  │  extension-logger.ts # 확장측 로깅/레벨/러거
│  │  │  perf.ts # 성능 계측/타임라인
│  │  │  test-mode.ts # 테스트 모드 로깅
│  │  logs/
│  │  │  ChunkWriter.ts # 청크 기반 파일 쓰기
│  │  │  HybridLogBuffer.ts # 링버퍼+파일 버퍼 하이브리드
│  │  │  IndexedLogStore.ts # 인덱스드 스토어(검색/범위)
│  │  │  LogFileIntegration.ts # k-way 병합/소스 통합
│  │  │  LogFileStorage.ts # 로그 파일 저장/오프셋
│  │  │  LogSearch.ts # 서버측 다중필드 검색
│  │  │  ManifestTypes.ts # 병합 매니페스트 타입
│  │  │  ManifestWriter.ts # 병합 매니페스트 생성/관리
│  │  │  PagedReader.ts # 인덱스 기반 페이지 리더
│  │  │  PaginationService.ts # 페이지 범위 계산/로드
│  │  │  ParserEngine.ts # 로그 파싱 엔진(JSON/필드 표준화)
│  │  │  Sanitizer.ts # 레코드 정규화/클렌징
│  │  │  time/
│  │  │  │  TimeParser.ts # 타임스탬프 파싱/연도 보정
│  │  │  │  TimezoneHeuristics.ts # 타임존/점프 휴리스틱
│  │  service/
│  │  │  ServiceFilePatcher.ts # 서비스 파일 패치/복구
│  │  │  serviceDiscovery.ts # 서비스 탐색/상태 확인
│  │  sessions/
│  │  │  LogSessionManager.ts # 로그 세션 라이프사이클
│  │  state/
│  │  │  DeviceState.ts # 장치 상태 모델
│  │  tasks/
│  │  │  MountTaskRunner.ts # 마운트 작업 실행
│  │  │  RestartTaskRunner.ts # 서비스/장치 재시작 작업
│  │  │  ToggleTaskRunner.ts # 토글형 작업 실행
│  │  │  UnmountTaskRunner.ts # 언마운트 작업 실행
│  │  │  guards/
│  │  │  │  HostStateGuard.ts # 작업 실행 전 상태 가드
│  │  │  workflow/
│  │  │  │  workflowEngine.ts # 작업 워크플로우 엔진
│  │  transfer/
│  │  │  FileTransferService.ts # tar+base64 전송/복호/검증
│  extension/
│  │  commands/
│  │  │  CommandHandlersConnect.ts # COMMANDHANDLERSCONNECT 관련 명령 핸들러
│  │  │  CommandHandlersGit.ts # COMMANDHANDLERSGIT 관련 명령 핸들러
│  │  │  CommandHandlersHomey.ts # COMMANDHANDLERSHOMEY 관련 명령 핸들러
│  │  │  CommandHandlersHost.ts # COMMANDHANDLERSHOST 관련 명령 핸들러
│  │  │  CommandHandlersLogging.ts # COMMANDHANDLERSLOGGING 관련 명령 핸들러
│  │  │  CommandHandlersParser.ts # COMMANDHANDLERSPARSER 관련 명령 핸들러
│  │  │  CommandHandlersUpdate.ts # COMMANDHANDLERSUPDATE 관련 명령 핸들러
│  │  │  CommandHandlersWorkspace.ts # COMMANDHANDLERSWORKSPACE 관련 명령 핸들러
│  │  │  ICommandHandlers.ts # 커맨드 핸들러 인터페이스
│  │  │  commandHandlers.ts # COMMANDHANDLERS 관련 명령 핸들러
│  │  │  edgepanel.buttons.ts # EdgePanel 내 버튼 바인딩
│  │  editors/
│  │  │  IPerfMonitorComponents.ts # Perf Monitor 에디터 구성 요소(iperfmonitorcomponents)
│  │  │  IPerfMonitorPanelComponents.ts # Perf Monitor 에디터 구성 요소(iperfmonitorpanelcomponents)
│  │  │  PerfMonitorCaptureManager.ts # Perf Monitor 에디터 구성 요소(perfmonitorcapturemanager)
│  │  │  PerfMonitorCommandHandler.ts # Perf Monitor 에디터 구성 요소(perfmonitorcommandhandler)
│  │  │  PerfMonitorDataManager.ts # Perf Monitor 에디터 구성 요소(perfmonitordatamanager)
│  │  │  PerfMonitorEditorProvider.ts # Perf Monitor 에디터 구성 요소(perfmonitoreditorprovider)
│  │  │  PerfMonitorExportManager.ts # Perf Monitor 에디터 구성 요소(perfmonitorexportmanager)
│  │  │  PerfMonitorHtmlGenerator.ts # Perf Monitor 에디터 구성 요소(perfmonitorhtmlgenerator)
│  │  │  PerfMonitorMessageHandler.ts # Perf Monitor 에디터 구성 요소(perfmonitormessagehandler)
│  │  │  PerfMonitorPanel.ts # Perf Monitor 에디터 구성 요소(perfmonitorpanel)
│  │  │  PerfMonitorWebviewManager.ts # Perf Monitor 에디터 구성 요소(perfmonitorwebviewmanager)
│  │  main.ts # VS Code activate/deactivate 및 초기 등록
│  │  messaging/
│  │  │  bridge.ts # 웹뷰 IPC 유틸(요청/응답/ACK/타임아웃)
│  │  │  hostWebviewBridge.ts # Host ↔ Webview 브릿지 구현
│  │  │  messageTypes.ts # IPC 메시지 타입 선언
│  │  panels/
│  │  │  EdgePanelActionRouter.ts # 패널 액션 라우팅
│  │  │  LogConnectionPicker.ts # 로그 연결 선택 UI
│  │  │  LogViewerPanelManager.ts # 로그뷰 관리/페이지/검색 응답
│  │  │  explorerBridge.ts # Explorer <-> Host 브릿지(워처/IPC)
│  │  │  extensionPanel.ts # EdgePanelProvider: 컨트롤/탭 렌더
│  │  setup/
│  │  │  parserConfigSeeder.ts # 커스텀 파서 설정 초기화/검증
│  │  │  userConfigSeeder.ts # 사용자 설정 시드/업그레이드
│  │  terminals/
│  │  │  AdbTerminal.ts # VS Code ADB 통합 터미널
│  │  │  SshTerminal.ts # VS Code SSH 통합 터미널
│  │  ui/
│  │  │  input.ts # QuickPick/입력 등 UI 헬퍼
│  │  update/
│  │  │  updater.ts # 최신버전 확인/다운로드
│  shared/
│  │  const.ts # 상수(경로/키/기본값)
│  │  env.ts # 환경 변수 로딩
│  │  errors.ts # 에러 타입/헬퍼
│  │  ipc/
│  │  │  messages.ts # IPC 메시지 공용 타입
│  │  types.ts # 공용 타입 정의
│  │  ui-input.ts # 웹뷰 입력 타입
│  │  utils.ts # 범용 유틸
│  types/
│  │  ssh2.d.ts # 타입 산출물/정의
│  │  style.d.ts # 타입 산출물/정의
│  │  vscode-webview.d.ts # 타입 산출물/정의
│  ui/
│  │  _shared/
│  │  │  bridge.ts # (설명 미상)
│  webviewers/
│  │  edge-panel/
│  │  │  app/
│  │  │  │  actions.ts # 액션 정의
│  │  │  │  effects.ts # 사이드이펙트/IPC
│  │  │  │  index.ts # 부트스트랩/스토어/브릿지
│  │  │  │  reducer.ts # 리듀서
│  │  │  │  store.ts # 간단 스토어
│  │  │  index.html # Edge Panel HTML
│  │  │  services/
│  │  │  │  ExplorerService.ts # 탐색기 API
│  │  │  │  HostBridge.ts # 웹뷰측 IPC 래퍼
│  │  │  │  LogService.ts # 로그 API
│  │  │  │  PersistService.ts # 로컬 저장소
│  │  │  styles/
│  │  │  │  base.css # Edge Panel 스타일
│  │  │  │  components.css # Edge Panel 스타일
│  │  │  │  layout.css # Edge Panel 스타일
│  │  │  │  tokens.css # Edge Panel 스타일
│  │  │  types/
│  │  │  │  model.ts # 모델 타입
│  │  │  views/
│  │  │  │  AppView.ts # 컨트롤/탭 UI 루트
│  │  │  │  Explorer/
│  │  │  │  │  ContextMenu.ts # 탐색기 컴포넌트
│  │  │  │  │  ExplorerView.ts # 탐색기 컴포넌트
│  │  │  │  │  TreeView.ts # 탐색기 컴포넌트
│  │  │  │  Layout/
│  │  │  │  │  Panel.ts # 패널/스플리터 UI
│  │  │  │  │  Splitter.ts # 패널/스플리터 UI
│  │  │  │  Logs/
│  │  │  │  │  LogsView.ts # 로그 프리뷰/컨트롤
│  │  log-viewer/
│  │  │  index.html # 로그뷰 HTML
│  │  │  react/
│  │  │  │  components/
│  │  │  │  │  App.ts # 로그뷰 컴포넌트(app)
│  │  │  │  │  BookmarkSquare.ts # 로그뷰 컴포넌트(bookmarksquare)
│  │  │  │  │  Bookmarks.ts # 로그뷰 컴포넌트(bookmarks)
│  │  │  │  │  FilterDialog.ts # 로그뷰 컴포넌트(filterdialog)
│  │  │  │  │  Grid.ts # 로그뷰 컴포넌트(grid)
│  │  │  │  │  GridHeader.ts # 로그뷰 컴포넌트(gridheader)
│  │  │  │  │  HighlightPopover.ts # 로그뷰 컴포넌트(highlightpopover)
│  │  │  │  │  MessageDialog.ts # 로그뷰 컴포넌트(messagedialog)
│  │  │  │  │  SearchDialog.ts # 로그뷰 컴포넌트(searchdialog)
│  │  │  │  │  SearchPanel.ts # 로그뷰 컴포넌트(searchpanel)
│  │  │  │  │  Toolbar.ts # 로그뷰 컴포넌트(toolbar)
│  │  │  │  ipc.ts # 웹뷰 IPC 래퍼
│  │  │  │  main.ts # React 진입/렌더
│  │  │  │  store.ts # 상태/액션/셀렉터
│  │  │  │  types.ts # 프런트 타입
│  │  │  styles/
│  │  │  │  tailwind.css # Tailwind/토큰 스타일
│  │  │  │  tokens.css # Tailwind/토큰 스타일
│  │  perf-monitor/
│  │  │  app.js # 성능 수집/Chart.js
│  │  │  style.css # 성능 모니터 스타일
│  │  shared/
│  │  │  utils.ts # 웹뷰 공용 유틸
types/
│  model.js # 타입 산출물/정의
```

# 🧭 VS Code Extension 입력 처리 가이드

> 이 문서는 **사용자 입력 UX를 통일**하고,  
> `showInputBox`의 포커스 손실 문제를 해결하기 위한 기준을 설명합니다.  
> 모든 입력(텍스트, 폴더 선택, 멀티스텝 등)은 일관된 유틸 모듈을 사용해 처리합니다.

---

## 📁 경로 관련 입력

### ✅ 원칙
- 경로(폴더·파일) 입력은 **직접 타이핑 대신 네이티브 선택창**을 사용합니다.
- `showOpenDialog()`는 OS 기본 탐색기를 사용하므로  
  **포커스를 잃어도 닫히지 않고**, 오타 입력을 방지할 수 있습니다.

### ✅ 사용 예시
```ts
import { pickFolder, pickFile } from '../../shared/ui-input.js';

// 폴더 선택
const folder = await pickFolder({
  title: '새 Workspace 베이스 폴더 선택 (하위에 workspace/가 생성됩니다)',
});
if (folder) {
  console.log('Selected folder:', folder.fsPath);
}

// 파일 선택
const file = await pickFile({
  title: '환경설정 파일 선택',
  filters: { JSON: ['json'], YAML: ['yaml', 'yml'] },
});
if (file) {
  console.log('Selected file:', file.fsPath);
}
```

## 🧩 여러 단계 입력 (QuickInput Wizard)

### ✅ 원칙
- 사용자가 여러 값을 순차적으로 입력해야 하는 경우 **QuickInput Wizard 패턴(`multiStep`)**을 사용합니다.  
- 각 단계는 포커스를 잃어도 유지되며, 한 번에 복합 입력 시나리오를 처리할 수 있습니다.

### ✅ 사용 예시
```ts
import { multiStep, promptText, pickFile } from '../../shared/ui-input.js';

type SshState = { host?: string; user?: string; key?: vscode.Uri };
const state: SshState = {};

await multiStep<SshState>([
  async (s) => { s.host = await promptText({ title: 'SSH Host', placeHolder: 'example.com' }); },
  async (s) => { s.user = await promptText({ title: 'SSH User', placeHolder: 'root' }); },
  async (s) => { s.key  = await pickFile({ title: 'SSH Private Key', filters: { 'Key files': ['pem','key'] } }); },
], state);

console.log('Result:', state);
```

## ✍️ 일반 입력 (텍스트 / 숫자 / 비밀번호 등)

### ✅ 원칙
- 모든 일반 입력은 `extension/ui/input.ts` 모듈의 유틸 함수를 사용합니다.  
- 내부적으로 `ignoreFocusOut: true`가 기본 적용되어  
  **탐색기 포커스를 옮겨도 입력창이 닫히지 않습니다.**

---

### ✅ 사용 예시
```ts
import { promptText, promptNumber, promptSecret, confirm } from '../../shared/ui-input.js';

// 텍스트 입력
const name = await promptText({
  title: '디바이스 이름 입력',
  placeHolder: '예) homey-edge-01',
});

// 숫자 입력
const retry = await promptNumber({
  title: '재시도 횟수',
  min: 1,
  max: 10,
});

// 비밀번호 입력
const token = await promptSecret({
  title: 'Access Token 입력',
  placeHolder: '토큰은 숨김 처리됩니다',
});

// 확인 대화상자
if (await confirm('새 설정을 저장하시겠습니까?')) {
  console.log('User confirmed');
}
```