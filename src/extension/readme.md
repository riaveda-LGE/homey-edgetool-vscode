# VS Code Extension Host (src/extension/\*\*)

## 개요

VS Code 확장의 **Extension Host 사이드**는 확장의 엔트리 포인트로, 초기 활성화와 각종 기능 등록을 담당한다.  
이 모듈은 사용자와 VS Code API 사이의 브리지 역할을 하며, Webview UI 및 백엔드 로직을 통합 관리한다.

---

## 주요 기능

### 1. 활성화 (Activation)

- 확장이 처음 실행될 때 `activate(context: ExtensionContext)`에서 초기화 수행
- 필요한 자원 등록 및 상태 복원
- 비활성화 시 `deactivate()`에서 리소스 정리

### 2. 명령 등록 (Command Registration)

- `vscode.commands.registerCommand`를 통해 확장의 명령(Command) 정의
- 명령어는 Command Palette, 단축키, UI 버튼 등에서 호출 가능
- 예: `extension.startService`, `extension.openPanel`

### 3. 웹뷰 제공 (Webview Provider)

- `WebviewViewProvider`를 구현하여 패널/탭 형태의 UI 제공
- HTML, CSS, JS로 UI 렌더링
- 메시지 패싱(`webview.postMessage`, `onDidReceiveMessage`)으로 확장 본체 ↔ 웹뷰 간 양방향 통신

### 4. 업데이트 체크 (Update Checker)

- 확장 버전과 원격 최신 버전을 비교
- 업데이트 가능 여부 확인 후 사용자에게 알림 제공
- 필요 시 다운로드 및 자동 설치 로직 연결

### 5. 로그 브리지 (Log Bridge)

- 확장 내부 로그를 수집하고 웹뷰로 전달
- `onStdout`, `onStderr`를 통해 외부 프로세스 출력도 수집 가능
- 로그 버퍼를 유지하여 초기 웹뷰 로딩 시 복원 가능

---

## 디렉터리 구조 (예시)

```
src/
└─ extension/
├─ extension.ts # 엔트리 포인트 (activate/deactivate)
├─ commands/ # 명령 등록 모듈
├─ panels/ # WebviewProvider 구현
├─ updater/ # 업데이트 체크 로직
└─ logger/ # 로그 브리지 및 로거 유틸
```
