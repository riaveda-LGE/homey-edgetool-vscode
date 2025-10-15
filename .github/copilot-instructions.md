# GitHub Copilot Instructions for Edge Tool

## 기본 지침사항
- **언어**: 언제나 한글로 대답해라
- **호칭**: 언제나 나를 형님으로 대해라
- **이름**: 앞으로 너의 이름은 춘식
- **코드 변경 및 수정 승인**: 코드 수정 또는 새로운 코드 생성 전에 반드시 다음 과정을 따라야 한다:
  1. 변경할 내용의 구체적인 설명 (무엇을 왜 변경하는지)
  2. **어떠한 사소한 수정사항이라 하더라도 반드시 승인 요청을 해야 한다.**

- **작업 기본 방침**: 새로운 파일 작성, 기존 코드 수정, 이슈 수정 등 모든 사항에 대해 기본방침은 언제나 분석이다. 난 수정보다 분석을 더 중요하게 여겨.

## Homey EdgeTool — VS Code Custom Editor 아키텍처 & 구현 가이드

*(Node.js/TypeScript 기반)*

> **목표:** VS Code 내부에서 Homey 장치와 SSH/ADB로 연결하여
> 로그를 실시간/파일 병합 형태로 표시하고, 동시에 Homey 기기 제어(Git 동기화, 마운트, 셸 명령 등)를 수행하는 통합 툴 구현.

---

## 📌 중요 요구사항

### 1. 기능 요구사항

- **homey-logging 기능 (VS Code Custom Editor + Webview)**
  - VS Code 안에서 동작해야 함.
  - 2가지 모드:
    - **실시간 로그 모드**: adb/ssh host 접근 → 실시간 텍스트 전달 및 표시.
    - **파일 병합 모드**: 여러 로그 파일을 시간 순서로 병합 → 단일 뷰 제공.

- **Update 기능 + Extension Panel UX**
  - 최신 버전 확인, 다운로드, 설치, Reload 지원.
  - Extension Panel에서 업데이트/재로드 버튼 제공.
  - 로그와 업데이트 상태를 통합 UX로 표시.

- **사용자 UX (명령 기반 기능)**
  - 연결/세션 관리: `connect_info`, `connect_change`
  - Host 작업: `host <command>`, `shell`
  - Homey 관리: `homey-restart`, `homey-mount`, `homey-unmount`, DevToken 관리, 로그 콘솔 토글, Docker 업데이트
  - 로그 뷰어: `homey-logging`, `homey-logging --dir <경로>`
  - Git 동기화: `git pull …`, `git push …`
  - 도움말/종료: `help`, `h`

### 2. 구현 요구사항

- 모든 로직은 **Node.js (TypeScript)** 로 구현.
- **프로세스 실행은 child_process.spawn 기반**(PowerShell/`/bin/sh -c`)으로 표준화.
- **네이티브 SCP/SFTP 미의존**: 파일 전송은 **SSH 표준 I/O + tar/base64 파이프** 방식으로 구현.
- **취소/정리 일관성**: VS Code Webview dispose/패널 닫힘/사용자 취소 → AbortController로 모든 하위 작업(SSH/압축/인코딩) **전파 취소**.

### 3. 성능/품질 요구사항

- **성능 계측 지원**: Extension Host와 Webview 모두 프로파일링/메모리 계측 가능.
- **개발 중 성능 로깅**: 특정 로직에 성능 측정 래퍼를 두어 실행 시간·메모리를 로깅.
- **메모리 관리 전략**: 로그는 스트리밍+chunk 단위로 전달, Webview는 가상 스크롤과 줄 수 제한 적용.
- **버퍼 모니터링 API**: HybridLogBuffer `getMetrics()` 제공, Extension Panel에서 시각화.

---

## 📌 중요 로직

### 1. Log File Integration Logic (시간 역순 병합)

- **목적**: 여러 로그 타입(system, homey, application 등)을 시간 역순으로 병합, 최신 로그를 먼저 보여줌.
- **핵심 요소**
  - `LogTypeData`: 타입별 파일/상태/타임존/진행 상황 관리.
  - `LogFileIntegration`: 전체 컨트롤러, 병렬 청크 처리, 타임존 보정, HybridLogBuffer 연동.
- **주요 기능**
  - 로그 파일 스캔 및 타입 분류.
  - 타임존 점프 감지/보정.
  - 청크 단위 처리 (streaming 방식).
  - 타입별 역순 정렬 후, **우선순위 큐 기반 k-way merge**로 전체 병합.
- **강점**: 최신 로그 우선 UX, 대용량 안전 처리, 에러 허용성, 확장 용이.

---

### 2. 로그 버퍼링 시스템 아키텍처 (4-버퍼 하이브리드)

- **목적**: 실시간 로그 모니터링 + 대용량 로그 분석 동시 지원.
- **구성 요소**
  - `HybridLogBuffer`: 중앙 버퍼 시스템, 4-버퍼 관리(realtime / viewportN / search / spill).
  - `ViewportRange`: 캐시 범위 메타데이터.
  - `LogFileStorage`: 파일 저장소(JSONL, 압축, 청크 분할, 범위 로드).
  - `LogBufferWriter`: 실시간 입력(ADB/SSH).
  - `LogFileIntegration`: 파일 입력 병합.
  - `InputSource`: 소스 메타데이터 관리.
- **검색**
  - 대상: realtime + viewport + LogFileStorage.
  - 방식: contains + regex/time-range/pagination.
- **최적화**
  - LRU/ARC 기반 뷰포트 캐시 교체, Prefetch.
  - 파일은 청크 단위 비동기 로드, 인덱스 활용.
  - 네트워크는 배치 전송 + 증분 업데이트 + 압축 옵션.

---

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

### 4. 실시간 로그 스트리밍 로직

- **파일 소스**: `tail -f <file>`
- **명령 소스**: `journalctl -f`, `dmesg -w` 등
- **구성**
  - Extension Host에서 spawn으로 SSH/ADB 실행
  - stdout 라인을 Webview로 전달
  - 취소/패널 닫힘 시 프로세스 종료

---

### 5. Webview 구조 & UX

- **모듈**
  - EventBus, ModuleLoader, AppState
  - WebSocketService (로그 스트림 수신)
  - LogViewer (가상 스크롤, 통계)
  - SearchManager, FilterManager, HighlightManager
  - BookmarkManager, TooltipManager
- **UX 정책**
  - 자동 스크롤: 하단 5% 이내면 유지, 벗어나면 해제
  - 검색: Ctrl+F, 실시간 하이라이트, 네비게이션
  - 북마크: 더블클릭 토글, 저장
  - 툴팁: 상세 보기, 복사 지원
  - 통계: totalLogs, 필터 후 개수 표시

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

## 1️⃣ 배치 전송 (Chunking)
- 작은 로그 여러 개를 한 번에 묶어 전송합니다.  
- **크기 기준:** 약 32–128KB 단위로 묶기  
- **주기 기준:** 16–60Hz 이내 (예: 30–100ms 간격으로 전송)  
- **예시:**
  ```ts
  // Host → Webview
  sendLogs(batch.slice(0, 500)); // 500줄 단위
  ```

## 2️⃣ ACK 기반 백프레셔 (Backpressure)

- Webview가 **`ack`** 를 보내기 전까지 **동시에 전송 중인 배치 수를 제한**합니다.  
- 보통 **`in-flight` 1~2개** 정도로 유지합니다.  
- 기존 **`Envelope`** 프로토콜의 `id` / `inReplyTo` 필드를 활용하여  
  요청–응답 상관관계를 관리합니다.  

**예시:**
```ts
// Host → Webview
sendLogs(batch, { id: '1234' });

// Webview → Host (ACK)
postMessage({ v: 1, type: 'ack', payload: { inReplyTo: '1234' } });
```

## 3️⃣ 전달 형식 최소화

- **JSON 직렬화 비용**을 줄이기 위해 전송 필드를 최소화합니다.  
- 로그 엔트리는 최소한의 필드만 포함하도록 합니다.  
  - 기본: `{ ts, text }`  
  - 옵션: `level`, `source` 등은 필요한 경우에만 포함  

**예시 (간소화된 로그 구조):**
```json
[
  { "ts": 1739262000000, "text": "Homey connected" },
  { "ts": 1739262000123, "text": "Fetching logs..." }
]
```

## 4️⃣ 초기 스냅샷 + 스트리밍 분리

- **대용량 로그를 한 번에 전송하지 않고**,  
  **초기 스냅샷 + 실시간 tail 스트림**으로 분리합니다.  
- 이렇게 하면 초기 로딩 지연을 최소화하면서, 실시간 로그도 즉시 표시할 수 있습니다.

### 📘 전략
- **(A)** 최근 **N줄(예: 10,000줄)** 을 한 번에 **스냅샷**으로 전송  
- **(B)** 이후 새 로그는 **실시간 스트리밍(배치 전송)**  
- **(C)** 과거 로그는 사용자가 스크롤/검색 요청 시 **on-demand 로딩**

**예시 시퀀스:**
```ts
// 1) 초기 스냅샷 (once)
webview.postMessage({
  v: 1,
  type: 'logs.snapshot',
  payload: { logs: latest10k }
});

// 2) 실시간 tail 스트리밍
setInterval(() => {
  const newBatch = collectNewLogs();
  webview.postMessage({ v: 1, type: 'logs.batch', payload: { logs: newBatch } });
}, 100);

// 3) 사용자가 과거 탐색 요청 시
webview.onDidReceiveMessage((msg) => {
  if (msg.type === 'logs.requestRange') {
    const rangeLogs = readLogsFromFile(msg.payload.range);
    webview.postMessage({ v: 1, type: 'logs.range', payload: { logs: rangeLogs } });
  }
});
```

## 5️⃣ Webview 렌더링 최적화

- DOM 조작은 DocumentFragment 로 모아서 한 번에 append 합니다.
- 대량 로그(수만~수십만 행)는 가상 스크롤(Virtualized List) 로 렌더링합니다.
- 렌더링/파싱 부하는 Web Worker 로 분리하면 더욱 효율적입니다.

## 6️⃣ 검색 및 필터링은 Host에서 수행

- 대용량 데이터를 Webview로 전송하지 말고, Host에서 미리 필터링/검색 후 요약 결과만 전송합니다.
- 예: "총 120,000건 중 50건 일치" + "상위 5개 미리보기"
- 상세 내용은 사용자가 요청할 때 페이징 전송합니다.

## 7️⃣ 압축 / 인코딩

- 초대용량 로그 전송 시 Host에서 gzip → base64 로 압축 전송합니다.
- Webview에서 pako 등으로 해제합니다.

---

### 9. Performance Monitoring Architecture

- **목적**: 전역 성능 모니터링 플래그로 On/Off 제어, Off 시 성능 오버헤드 0%
- **핵심 요소**
  - `PerformanceProfiler`: 싱글톤 클래스, `isEnabled` 플래그 관리
  - `measureFunction()`: 함수 실행 시간 측정 (데코레이터용)
  - `measureIO()`: I/O 작업 성능 측정 (데코레이터용)
- **On/Off 동작**
  - **Off 모드**: `isEnabled = false` → 모든 측정 로직 스킵 (최대 성능)
  - **On 모드**: `isEnabled = true` → 측정 및 기록 수행
- **데코레이터**
  - `@measure`: 함수 실행 시간 측정
  - `@measureIO`: 파일 I/O 성능 측정
- **명령어**
  - `togglePerformanceMonitoring`: On/Off 모드 전환 (Quick Pick)
  - On 선택: `globalProfiler.enable()` + 패널 열기
  - Off 선택: `globalProfiler.disable()` + 패널 닫기
- **주의사항**
  - Off 모드에서는 모든 `@measure`/`@measureIO` 데코레이터가 그냥 함수 실행 (오버헤드 없음)
  - 직접 `measureFunction()` 호출도 `isEnabled` 체크 적용
  - 실제 캡처는 panel의 "Start Capture" 버튼에서 수동 제어

---

- [ ] ConnectionManager (SSH/ADB)
- [ ] HomeyController (mount/git/homey 명령)
- [ ] FileTransferService (tar/base64 파이프)
- [ ] LogSessionManager (realtime/file merge)
- [ ] CustomEditorProvider (webview 브리지)
- [ ] WebSocketService (배치 큐 + 재연결)
- [ ] LogViewer (가상 스크롤 + 통계)
- [ ] Filter/Search/Highlight/Bookmark/Tooltip 매니저
- [ ] AbortController 일괄 취소
- [ ] PanelProvider (상태/업데이트)
- [ ] 설정 스키마 (connection, logs, buffer 등)

---

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

## 프로젝트 트리
```
homey-edgetool/
├─ src/
│  ├─ extension/                          # VS Code 진입점과 확장 전용 코드
│  │  ├─ main.ts                          # activate/deactivate, 초기 부트스트랩
│  │  ├─ commands/
│  │  │  └─ commandHandlers.ts            # help/h, connect_info, homey-logging 등 라우팅
│  │  │  └─ edgepanel.buttons.ts           # button 정의 SSOT
│  │  ├─ editors/
│  │  │  └─ LogViewEditorProvider.ts      # Custom Editor + Webview (homey-logging)
│  │  ├─ messaging/
│  │  │  ├─ hostWebviewBridge.ts          # Webview ↔ Extension message bridge
│  │  │  ├─ messageTypes.ts               # 공용 메시지 타입(웹/호스트 공용 import)
│  │  │  └─ bridge.ts                     # Webview 메시징 브리지 (이동됨)
│  │  ├─ panels/
│  │  │  └─ extensionPanel.ts             # Extension Panel 제공자
│  │  └─ update/
│  │     └─ updater.ts                    # checkLatestVersion(), downloadAndInstall()
│  │
│  ├─ core/                               # 핵심 비즈니스 로직(런타임 독립)
│  │  ├─ config/
│  │  │  ├─ schema.ts                     # 사용자 설정 스키마
│  │  │  └─ userdata.ts                   # 워크스페이스 설정 관리
│  │  ├─ connection/
│  │  │  ├─ ConnectionManager.ts          # 호스트별 연결 관리
│  │  │  ├─ ExecRunner.ts                 # spawn 표준화
│  │  │  ├─ sshClient.ts                  # SSH 클라이언트 (adapters/에서 이동)
│  │  │  └─ adbClient.ts                  # ADB 클라이언트 (adapters/에서 이동)
│  │  ├─ logging/
│  │  │  ├─ extension-logger.ts           # OutputChannel + sink
│  │  │  └─ perf.ts                       # 성능 계측
│  │  ├─ logs/
│  │  │  ├─ HybridLogBuffer.ts            # 4-버퍼 하이브리드
│  │  │  ├─ LogFileIntegration.ts         # k-way 병합
│  │  │  ├─ LogFileStorage.ts             # JSONL 저장/읽기
│  │  │  ├─ LogSearch.ts                  # 검색
│  │  │  └─ types.ts                      # LogEntry 등 타입
│  │  ├─ sessions/
│  │  │  └─ LogSessionManager.ts          # 세션 관리
│  │  └─ transfer/
│  │     └─ FileTransferService.ts        # tar/base64 전송
│  │
│  ├─ shared/                             # 공용 유틸/타입
│  │  ├─ const.ts                         # 상수
│  │  ├─ types.ts                         # 공용 타입
│  │  ├─ errors.ts                        # 에러 분류
│  │  ├─ utils.ts                         # 공용 유틸
│  │  └─ ui-input.ts                      # UI 입력 유틸 (extension/ui/에서 이동)
│  │
│  └─ ui/                                 # Webview 리소스
│     ├─ log-viewer/
│     │  ├─ index.html                    # 로그 뷰어 웹뷰
│     │  ├─ app.ts                        # 부트스트랩
│     │  ├─ services/
│     │  │  └─ ws.ts                      # postMessage 래퍼
│     │  ├─ modules/
│     │  │  └─ LogViewer.ts               # 가상 스크롤
│     │  └─ protocol.ts                   # 메시지 타입
│     └─ edge-panel/
│        ├─ index.html                    # Edge Panel 웹뷰
│        ├─ panel.css                     # 스타일
│        └─ panel.ts                      # 로직
│
├─ media/                                 # 아이콘/정적자원
│  └─ resources/edge-icon.svg
├─ scripts/
│  └─ perf/
│     └─ run-merge-bench.ts               # 벤치마크
├─ package.json
├─ tsconfig.json
├─ TypeScript 컴파일 (tsc)
└─ README.md / CHANGELOG.md / LICENSE
```

## 모듈 간단 설명
extension/

main.ts: 확장 진입점. 로거 초기화, 전역 예외 후킹, 업데이트 확인, EdgePanel 등록.

commands/

commandHandlers.ts: help/h, connect_info, homey-logging 등 명령 및 버튼 라우팅.

edgepanel.buttons.ts: button 정의 SSOT, DTO 변환.

editors/

LogViewEditorProvider.ts: Custom Editor + Webview로 homey-logging 뷰어.

messaging/

messageTypes.ts: Host/Webview 공유 메시지 타입.

hostWebviewBridge.ts: Host 측 메시지 브리지.

bridge.ts: Webview 측 메시징 브리지 (ui/_shared/에서 이동).

panels/

extensionPanel.ts: Extension Panel 제공자 (버튼 이벤트 라우팅).

update/

updater.ts: 버전 체크, 다운로드/설치.

core/

config/

schema.ts: 사용자 설정 스키마.

userdata.ts: 워크스페이스 설정 관리.

connection/

ConnectionManager.ts: 호스트별 연결 관리.

ExecRunner.ts: spawn 표준화.

sshClient.ts: SSH 클라이언트 (adapters/에서 이동).

adbClient.ts: ADB 클라이언트 (adapters/에서 이동).

logging/

extension-logger.ts: OutputChannel + sink.

perf.ts: 성능 계측.

logs/

HybridLogBuffer.ts: 4-버퍼 하이브리드.

LogFileIntegration.ts: k-way 병합.

LogFileStorage.ts: JSONL 저장/읽기.

LogSearch.ts: 검색.

types.ts: LogEntry 등 타입.

sessions/

LogSessionManager.ts: 세션 관리.

transfer/

FileTransferService.ts: tar/base64 전송.

shared/

const.ts: 상수.

types.ts: 공용 타입.

errors.ts: 에러 분류.

utils.ts: 공용 유틸.

ui-input.ts: UI 입력 유틸 (extension/ui/에서 이동).

ui/

log-viewer/: Custom Editor Webview.

edge-panel/: Edge Panel Webview.


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