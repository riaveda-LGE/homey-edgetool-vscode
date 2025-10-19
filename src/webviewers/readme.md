## 4. Webview UI (src/webviewers/\*\*)

4.  Webview UI (src/webviewers/\*\*)

### 개요

**Webview UI 레이어**는 VS Code 확장에서 제공하는 **브라우저 런타임 기반 화면**이다.  
HTML/CSS/JS로 작성된 UI를 빌드 후 `dist/webviewers/**`에 배치하고,  
Extension Host가 이를 Webview에 로드하여 사용자에게 표시한다.

이 레이어는 두 가지 주요 화면을 제공한다:

- **Edge Panel**: 사이드 패널 형태의 콘솔 UI
- **Log Viewer**: 텍스트 에디터 기반 로그 뷰어

---

### 주요 기능

#### 1. Edge Panel (사이드 패널 콘솔)

- VS Code `WebviewViewProvider`로 등록되어 사이드바에 표시
- 현재 상태(버전, 업데이트 여부, 로그 등)를 실시간 표시
- 버튼/체크박스 등 기본 제어 컨트롤 제공
- Extension Host ↔ Webview 간 메시지 교환으로 동작 (예: 명령 실행, 로그 출력)

#### 2. Log Viewer (텍스트 에디터형 뷰)

- VS Code `CustomEditorProvider` 형태로 제공
- 로그 파일 또는 스트림을 텍스트 에디터 스타일로 시각화
- 필터, 검색, 스크롤/자동 스크롤 기능 지원
- 대용량 로그도 효율적으로 표시 가능

#### 3. 빌드 & 배포

- 개발 소스: `src/webviewers/**` (TypeScript/HTML/CSS/JS)
- 빌드 출력: `dist/webviewers/**`
- 확장 실행 시 `dist/webviewers/**`의 리소스를 Webview에 로드
- Content Security Policy(CSP) 적용으로 안전한 실행 보장

---

### 디렉터리 구조 (예시)

```
src/
└─ webviewers/
├─ edge-panel/ # 사이드 패널 webviewer
│ ├─ index.html
│ ├─ panel.ts
│ └─ style.css
├─ log-viewer/ # 로그 뷰어 webviewer
│ ├─ index.html
│ ├─ viewer.ts
│ └─ style.css
└─ common/ # 공통 webviewer 컴포넌트/유틸

빌드 후:

dist/
└─ webviewers/
├─ edge-panel/
└─ log-viewer/
```
