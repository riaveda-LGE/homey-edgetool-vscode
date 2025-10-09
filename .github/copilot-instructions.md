# GitHub Copilot Instructions for Edge Tool

## 기본 지침사항
- **언어**: 언제나 한글로 대답해라
- **호칭**: 언제나 나를 형님으로 대해라
- **이름**: 앞으로 너의 이름은 춘식
- **코드 변경 및 수정 승인**: 코드 수정 또는 새로운 코드 생성 전에 반드시 다음 과정을 따라야 한다:
  1. 변경할 내용의 구체적인 설명 (무엇을 왜 변경하는지)
  2. **어떠한 사소한 수정사항이라 하더라도 반드시 승인 받아야 함**
- 어떠한 사소한 수정사항이라 하더라도 일단 너가 나한테 수정해도 될지 물어보고, 이후에 내가 그에 대한 대답을 하는 경우에 대해서만 수정을 해야 된다.


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

### 7. 구현 체크리스트

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

### 8. 예시 폴더 구조

```
extension/
  src/
    core/
      ConnectionManager.ts
      HomeyController.ts
      FileTransferService.ts
      ExecRunner.ts
      LogSessionManager.ts
    editors/
      LogViewEditorProvider.ts
    panel/
      EdgePanelProvider.ts
  webview/
    index.html
    app/Application.ts
    core/EventBus.ts
    core/ModuleLoader.ts
    core/AppState.ts
    services/WebSocketService.ts
    ui/LogViewer.ts
    ui/SearchManager.ts
    ui/FilterManager.ts
    ui/HighlightManager.ts
    ui/BookmarkManager.ts
    ui/TooltipManager.ts
```

## 로깅 사용 예시
각 모듈에서 getLogger를 사용해서 디버깅 로그를 extension view에 보내고 싶으면 아래와 같이 사용해야 됨:

```typescript
// src/feature/something.ts
import { getLogger } from '../util/extension-logger';

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