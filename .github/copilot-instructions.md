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
> edgetool 확장 모듈이 VS Code에 로드되면서 초기화를 진행 및 확장 패널에 Control/Explorer/Log 뷰어를 생성하는 기능. 확장 패널의 모든 뷰가 정상적으로 보이는데 책임을 짐
### function: 로그파싱
> 파일병합모드로 로그를 열었을 때 주어진 폴더에 있는 로그파일을 읽고 해당 로그의 내용을 파싱해서 버퍼에 저장을 할 수 있도록 하는 기능
### function: 로그병합
> 각 로그타입의 로그들이 파싱되면 이를 시간 역순으로 정렬 및 타임존 보정 후 우선순위 큐 기반 k-way merge 알고리즘으로 전체 로그를 병합하는 기능
### function: 스크롤에_따른_로그_뷰_로드_갱신
> 사용자가 로그 뷰어에서 스크롤을 내릴 때 추가 로그를 자동으로 로드하고 뷰를 업데이트하는 기능
### function: custom_log_parser_설정
> custom_log_parser파일 내용을 읽고 그 안에 정의된 내용인 requirements, preflight, parser 동작에 실질적인 로직을 제공 합니다.
### function: 타임존_점프_감지_및_보정
> 로그의 타임스탬프를 분석하여 타임존 점프를 감지하고, 이를 보정하는 기능을 제공합니다.

# Homey EdgeTool — Project Structure
```
homey-edgetool/
├─ .github/                               # GitHub 관련 설정 및 문서
│  ├─ copilot-instructions.md             # Copilot 지침 및 프로젝트 구조 문서
│  └─ workflows/                          # GitHub Actions 워크플로우
│     ├─ build-release.yml                # 빌드 및 릴리스 워크플로우
│     └─ ci.yml                           # 지속적 통합 워크플로우
├─ doc/                                   # 프로젝트 문서
│  ├─ instruction.md                      # 프로젝트 지침 및 사용법
│  ├─ logging-0-parser.md                 # 로그 파서 설계 및 구현 문서
│  ├─ logging_parse_integration_logic.md  # 로그 파싱 통합 로직 문서
│  ├─ logparser_logic.md                  # 로그 파서 로직 문서
│  └─ perf-guide.md                       # 성능 가이드 문서
├─ media/                                 # 아이콘 및 정적 자원
│  └─ resources/
│     ├─ custom_log_parser.template.v1.json # 커스텀 로그 파서 템플릿 JSON # custom_log_parser_설정 # 로그파싱
│     ├─ edge-icon.svg                    # 확장 아이콘 SVG 파일
│     └─ help.md                          # 도움말 문서
├─ scripts/                               # 빌드/배포 및 유틸리티 스크립트
│  ├─ checking_count_between_json_to_log.js
│  ├─ clean-reinstall.ps1                 # 클린 재설치 PowerShell 스크립트
│  ├─ deploy.js                           # 배포 JavaScript 스크립트
│  ├─ run-jest.mjs
│  ├─ dummy_log/                          # 더미 로그 생성 스크립트
│  │  ├─ generate-homey-merged.js         # 병합된 Homey 로그 생성
│  │  └─ split-log-by-type.js             # 로그 타입별 분할
│  ├─ get_source/                         # 소스 가져오기 관련 스크립트
│  │  ├─ export_source_list.ps1           # 소스 목록 내보내기 스크립트
│  │  ├─ extract_source_list_via_function.ps1 # 함수를 통한 소스 목록 추출 스크립트
│  │  ├─ get_source.ps1                   # 소스 가져오기 메인 스크립트
│  │  ├─ source_list.txt                  # 소스 목록 텍스트 파일
│  │  └─ source.tmp                       # 임시 소스 파일
│  └─ perf/
│     └─ run-merge-bench.ts               # 로그 병합 벤치마크 실행 스크립트
├─ src/
│  ├─ __test__/                           # 중앙화된 테스트 파일들
│  │  ├─ LogMergePaginationTypeRestore.test.ts # 로그 병합 페이지네이션 타입 복원 테스트 # 로그병합
│  │  └─ helpers/                         # 테스트 헬퍼 유틸리티
│  │     └─ testFs.ts                     # 테스트 파일 시스템 유틸리티
│  ├─ core/                               # 핵심 비즈니스 로직 (런타임 독립)
│  │  ├─ readme.md                        # 코어 모듈 설명 문서
│  │  ├─ config/
│  │  │  ├─ schema.ts                     # 사용자 설정 스키마 정의 # custom_log_parser_설정
│  │  │  └─ userdata.ts                   # 워크스페이스 설정 관리 구현 # custom_log_parser_설정 # 확장_초기화
│  │  ├─ connection/
│  │  │  ├─ adbClient.ts                  # ADB 클라이언트 구현
│  │  │  ├─ ConnectionManager.ts          # 호스트별 연결 상태 관리
│  │  │  ├─ ExecRunner.ts                 # 프로세스 실행 표준화 유틸리티
│  │  │  ├─ HomeyController.ts            # Homey 디바이스 제어 로직
│  │  │  └─ sshClient.ts                  # SSH 클라이언트 구현
│  │  ├─ logging/
│  │  │  ├─ console-logger.ts             # 콘솔 로거 구현
│  │  │  ├─ extension-logger.ts           # OutputChannel 기반 로깅 싱크 구현
│  │  │  ├─ perf.ts                       # 성능 계측 데코레이터
│  │  │  └─ test-mode.ts                  # 테스트 모드 로깅 유틸리티
│  │  ├─ logs/
│  │  │  ├─ ChunkWriter.ts                # 로그 청크 쓰기 유틸리티 # 로그병합 # 스크롤에_따른_로그_뷰_로드_갱신
│  │  │  ├─ HybridLogBuffer.ts            # 하이브리드 로그 버퍼 관리 (4-버퍼 시스템) # 스크롤에_따른_로그_뷰_로드_갱신
│  │  │  ├─ IndexedLogStore.ts            # 인덱스 기반 로그 저장소 # 로그병합
│  │  │  ├─ LogFileIntegration.ts         # 로그 파일 통합 및 병합 컨트롤러 # 로그파싱 # custom_log_parser_설정 # 로그병합 # 스크롤에_따른_로그_뷰_로드_갱신 # 타임존_점프_감지_및_보정
│  │  │  ├─ LogFileStorage.ts             # 로그 파일 저장/읽기 구현 # 스크롤에_따른_로그_뷰_로드_갱신
│  │  │  ├─ LogSearch.ts                  # 로그 검색 기능 구현
│  │  │  ├─ ManifestTypes.ts              # 로그 매니페스트 타입 정의 # 로그병합 # 스크롤에_따른_로그_뷰_로드_갱신
│  │  │  ├─ ManifestWriter.ts             # 로그 매니페스트 쓰기 로직 # 로그병합 # 스크롤에_따른_로그_뷰_로드_갱신
│  │  │  ├─ PagedReader.ts                # 페이지드 로그 리더 구현 # 스크롤에_따른_로그_뷰_로드_갱신 # 로그병합
│  │  │  ├─ PaginationService.ts          # 로그 페이지네이션 서비스 # 스크롤에_따른_로그_뷰_로드_갱신 # 로그병합
│  │  │  ├─ ParserEngine.ts               # 로그 파싱 엔진 구현 # 로그파싱 # custom_log_parser_설정
│  │  │  ├─ Sanitizer.ts                  # 로그 데이터 정제 유틸리티
│  │  │  └─ time/                         # 시간 관련 유틸리티
│  │  │    ├─ TimeParser.ts               # 로그 시간 파서 # 로그파싱 # 로그병합 # 타임존_점프_감지_및_보정
│  │  │    └─ TimezoneHeuristics.ts       # 타임존 휴리스틱 로직 # 로그파싱 # 로그병합 # 타임존_점프_감지_및_보정
│  │  ├─ sessions/
│  │  │  └─ LogSessionManager.ts          # 로그 세션 관리 구현 # custom_log_parser_설정
│  │  ├─ transfer/
│  │  │  └─ FileTransferService.ts        # 파일 전송 서비스 (tar/base64 over SSH)
│  │  └─ workspace/
│  │     └─ init.ts                        # 워크스페이스 초기화 로직
│  ├─ extension/                          # VS Code 확장 진입점 및 확장 전용 코드
│  │  ├─ main.ts                          # 확장 메인 진입점 # 확장_초기화 # custom_log_parser_설정
│  │  ├─ readme.md                        # 확장 모듈 설명 및 구조 문서
│  │  ├─ commands/
│  │  │  ├─ commandHandlers.ts            # 메인 명령 핸들러 라우팅 및 버튼 이벤트 처리 # custom_log_parser_설정
│  │  │  ├─ CommandHandlersConnect.ts     # 연결 관련 명령 핸들러 (호스트 연결/해제)
│  │  │  ├─ CommandHandlersGit.ts         # Git 관련 명령 핸들러 (pull/push 등)
│  │  │  ├─ CommandHandlersHomey.ts       # Homey 디바이스 제어 명령 핸들러
│  │  │  ├─ CommandHandlersHost.ts        # 호스트 작업 명령 핸들러 (셸 실행 등)
│  │  │  ├─ CommandHandlersLogging.ts     # 로깅 관련 명령 핸들러
│  │  │  ├─ CommandHandlersParser.ts      # 로그 파서 관련 명령 핸들러 # custom_log_parser_설정
│  │  │  ├─ CommandHandlersUpdate.ts      # 업데이트 관련 명령 핸들러
│  │  │  ├─ CommandHandlersWorkspace.ts   # 워크스페이스 관련 명령 핸들러 # custom_log_parser_설정
│  │  │  ├─ edgepanel.buttons.ts           # Edge Panel 버튼 정의 및 메타데이터 SSOT
│  │  │  └─ ICommandHandlers.ts           # 명령 핸들러 인터페이스 정의
│  │  ├─ editors/
│  │  │  ├─ IPerfMonitorComponents.ts     # 성능 모니터 컴포넌트 인터페이스
│  │  │  ├─ IPerfMonitorPanelComponents.ts # 성능 모니터 패널 컴포넌트 인터페이스
│  │  │  ├─ PerfMonitorCaptureManager.ts  # 성능 데이터 캡처 관리 로직
│  │  │  ├─ PerfMonitorCommandHandler.ts  # 성능 모니터 명령 핸들러
│  │  │  ├─ PerfMonitorDataManager.ts     # 성능 데이터 관리 및 처리
│  │  │  ├─ PerfMonitorEditorProvider.ts  # 성능 모니터 에디터 제공자 구현
│  │  │  ├─ PerfMonitorExportManager.ts   # 성능 데이터 내보내기 관리
│  │  │  ├─ PerfMonitorHtmlGenerator.ts   # 성능 모니터 HTML 생성 로직
│  │  │  ├─ PerfMonitorMessageHandler.ts  # 성능 모니터 메시지 핸들링
│  │  │  ├─ PerfMonitorPanel.ts           # 성능 모니터 패널 컴포넌트
│  │  │  └─ PerfMonitorWebviewManager.ts  # 성능 모니터 웹뷰 관리
│  │  ├─ messaging/
│  │  │  ├─ bridge.ts                     # 메시징 브리지 유틸리티
│  │  │  ├─ hostWebviewBridge.ts          # 호스트 ↔ 웹뷰 메시지 브리지 구현 # 스크롤에_따른_로그_뷰_로드_갱신
│  │  │  └─ messageTypes.ts               # 공용 메시지 타입 정의
│  │  ├─ panels/
│  │  │  ├─ EdgePanelActionRouter.ts      # 버튼 이벤트 → 액션 라우팅 로직 # 확장_초기화
│  │  │  ├─ explorerBridge.ts             # 파일 탐색기 브리지 구현 # 확장_초기화
│  │  │  ├─ extensionPanel.ts             # 메인 확장 패널 제공자 및 Webview 관리 # 확장_초기화
│  │  │  ├─ LogConnectionPicker.ts        # 로그 연결 선택 QuickPick 구현 # 로그파싱
│  │  │  └─ LogViewerPanelManager.ts      # 독립 로그 뷰어 패널 컨트롤러 # 로그파싱 # 로그병합 # 스크롤에_따른_로그_뷰_로드_갱신 # custom_log_parser_설정
│  │  ├─ setup/
│  │  │  └─ parserConfigSeeder.ts         # 파서 설정 초기화 및 시딩 로직 # custom_log_parser_설정
│  │  └─ update/
│  │     └─ updater.ts                    # 확장 업데이트 관리 로직
│  ├─ shared/                             # 공용 유틸리티 및 타입
│  │  ├─ const.ts                         # 상수 정의 모음 # custom_log_parser_설정 # 확장_초기화 # 스크롤에_따른_로그_뷰_로드_갱신 # 로그병합
│  │  ├─ env.ts                           # 환경 변수 관리 유틸리티 # 확장_초기화
│  │  ├─ errors.ts                        # 에러 처리 및 정의
│  │  ├─ featureFlags.ts                  # 기능 플래그 관리 # 스크롤에_따른_로그_뷰_로드_갱신
│  │  ├─ ipc/                             # IPC 메시지 관련
│  │  │  └─ messages.ts                   # IPC 메시지 정의 및 타입 # 스크롤에_따른_로그_뷰_로드_갱신 # 로그병합 # 확장_초기화 # 로그파싱 # custom_log_parser_설정
│  │  ├─ types.ts                         # 공용 타입 정의
│  │  ├─ ui-input.ts                      # UI 입력 유틸리티 (입력창/선택창 표준화) # 확장_초기화
│  │  └─ utils.ts                         # 공용 유틸리티 함수들 # custom_log_parser_설정
│  ├─ types/                              # 타입 정의 파일들
│  │  ├─ style.d.ts                       # 스타일 관련 타입 정의
│  │  └─ vscode-webview.d.ts              # VS Code 웹뷰 타입 정의
│  └─ webviewers/                         # Webview 리소스 (ES 모듈 기반)
│     ├─ readme.md                        # Webviewers 모듈 설명 문서
│     ├─ edge-panel/
│     │  ├─ index.html                    # Edge Panel 웹뷰 HTML 엔트리 # 확장_초기화
│     │  ├─ app/
│     │  │  ├─ actions.ts                 # 액션 타입 및 크리에이터 정의 # 확장_초기화 # 스크롤에_따른_로그_뷰_로드_갱신
│     │  │  ├─ effects.ts                 # 부수효과 처리 (postMessage, 타이머 등) # 확장_초기화
│     │  │  ├─ index.ts                   # Edge Panel 부트스트랩 및 스토어 초기화 # 확장_초기화 # 스크롤에_따른_로그_뷰_로드_갱신
│     │  │  ├─ reducer.ts                 # 상태 업데이트 순수 함수 (MVU 패턴) # 확장_초기화 # 스크롤에_따른_로그_뷰_로드_갱신
│     │  │  └─ store.ts                   # Zustand 기반 상태 관리 스토어
│     │  ├─ services/
│     │  │  ├─ ExplorerService.ts         # 파일 탐색기 API 래핑 서비스 # 확장_초기화
│     │  │  ├─ HostBridge.ts              # postMessage 이벤트 → 액션 변환 브리지 # 확장_초기화
│     │  │  ├─ LogService.ts              # 로그 추가/리셋 래핑 서비스 # 스크롤에_따른_로그_뷰_로드_갱신
│     │  │  └─ PersistService.ts          # 패널 상태 저장/복원 서비스 # 확장_초기화
│     │  ├─ styles/
│     │  │  ├─ base.css                   # 리셋, 타이포그래피, 색상 토큰 # 확장_초기화
│     │  │  ├─ components.css             # Panel/Titlebar/Tree/ContextMenu 컴포넌트 스타일 # 확장_초기화
│     │  │  ├─ layout.css                 # #root 그리드 및 패널 배치 스타일 # 확장_초기화
│     │  │  └─ tokens.css                 # VS Code 테마 토큰 → 로컬 변수 매핑 # 확장_초기화
│     │  ├─ types/
│     │  │  └─ model.ts                   # Edge Panel 상태/트리노드/섹션 타입 정의 # 확장_초기화
│     │  └─ views/
│     │    ├─ AppView.ts                  # 루트 앱 뷰 및 그리드 레이아웃 관리 # 확장_초기화 # 스크롤에_따른_로그_뷰_로드_갱신
│     │    ├─ ControlsView.ts             # 컨트롤 섹션 뷰 및 버튼 렌더링 # 확장_초기화
│     │    ├─ Explorer/
│     │    │  ├─ ContextMenu.ts           # 우클릭 메뉴 및 인라인 폼/확인 컴포넌트 # 확장_초기화
│     │    │  ├─ ExplorerView.ts          # 파일 탐색기 패널 전체 뷰 # 확장_초기화
│     │    │  └─ TreeView.ts              # 트리 렌더링, 키보드 내비게이션, 가상화 # 확장_초기화
│     │    ├─ Layout/
│     │    │  ├─ Panel.ts                 # 공통 패널 컨테이너 및 타이틀바 컴포넌트 # 확장_초기화
│     │    │  └─ Splitter.ts              # 상단/중단 스플리터 컴포넌트 # 확장_초기화
│     │    └─ Logs/
│     │       └─ LogsView.ts              # 로그 패널 뷰, 줄 누적 및 가상 스크롤 # 스크롤에_따른_로그_뷰_로드_갱신
│     ├─ log-viewer/                      # 로그 뷰어 웹뷰 리소스
│     │  ├─ index.html                    # 로그 뷰어 웹뷰 HTML 엔트리
│     │  ├─ react/
│     │  │  ├─ components/
│     │  │  │  ├─ App.tsx                 # 메인 React 앱 컴포넌트
│     │  │  │  ├─ BookmarkSquare.tsx      # 북마크 사각형 표시 컴포넌트
│     │  │  │  ├─ Bookmarks.tsx           # 북마크 관리 컴포넌트
│     │  │  │  ├─ FilterDialog.tsx        # 필터 설정 다이얼로그
│     │  │  │  ├─ Grid.tsx                # 로그 그리드 컴포넌트 # 스크롤에_따른_로그_뷰_로드_갱신
│     │  │  │  ├─ GridHeader.tsx          # 그리드 헤더 컴포넌트
│     │  │  │  ├─ HighlightPopover.tsx    # 하이라이트 팝오버 컴포넌트
│     │  │  │  ├─ MessageDialog.tsx       # 메시지 다이얼로그 컴포넌트
│     │  │  │  ├─ SearchDialog.tsx        # 검색 설정 다이얼로그
│     │  │  │  ├─ SearchPanel.tsx         # 검색 패널 컴포넌트
│     │  │  │  └─ Toolbar.tsx             # 툴바 컴포넌트 # 스크롤에_따른_로그_뷰_로드_갱신
│     │  │  ├─ ipc.ts                     # React 앱 IPC 통신 유틸리티 # 스크롤에_따른_로그_뷰_로드_갱신 # 로그병합
│     │  │  ├─ main.tsx                   # React 앱 진입점 및 렌더링
│     │  │  ├─ store.ts                   # Zustand 기반 상태 관리 # 스크롤에_따른_로그_뷰_로드_갱신 # 로그병합
│     │  │  └─ types.ts                   # React 앱 타입 정의
│     │  └─ styles/
│     │    ├─ tailwind.css                # Tailwind CSS 스타일시트
│     │    └─ tokens.css                  # 테마 토큰 및 하이라이트 스타일
│     ├─ perf-monitor/
│     │  ├─ app.js                        # 성능 모니터 앱 (Chart.js 기반)
│     │  └─ style.css                     # 성능 모니터 스타일시트
│     └─ shared/
│        └─ utils.ts                      # Webview 공용 유틸리티 함수들
├─ .gitattributes                         # Git 속성 설정
├─ .gitignore                             # Git 제외 파일
├─ .prettierignore                        # Prettier 제외 파일
├─ .prettierrc                            # Prettier 설정
├─ diff.txt                               # 차이점 파일
├─ eslint.config.js                       # ESLint 설정
├─ homey-edgetool-0.0.2.vsix              # 빌드된 VS Code 확장 파일
├─ jest.setup.ts                          # Jest 테스트 설정
├─ LICENSE                                # 라이선스 파일
├─ package.json                           # 프로젝트 설정 및 의존성
├─ package-lock.json                      # 패키지 잠금 파일
├─ postcss.config.mjs                     # PostCSS 설정 (Tailwind용)
├─ README.md                              # 프로젝트 README
├─ tailwind.config.js                     # Tailwind CSS 설정
├─ tsconfig.jest.json                     # Jest용 TypeScript 설정
├─ tsconfig.json                          # TypeScript 설정
├─ tsconfig.webview.json                  # Webview용 TypeScript 설정
├─ webpack.config.js                      # Webpack 빌드 설정
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