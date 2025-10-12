# Control 패널 **신규 버튼 추가 가이드**

본 문서는 Homey EdgeTool의 **Control 패널 버튼을 선언형으로 관리**하는 규칙을 설명합니다.  
버튼 정의는 단일 파일 **`src/extension/commands/edgepanel.buttons.ts`**(SSOT)에 모여 있습니다.

---

## 1) 큰 그림

```
[edgepanel.buttons.ts]  ← 버튼/섹션 "정의서(데이터)"
       │  toDTO(ctx)
       ▼
[extensionPanel.ts] (Host)
  - buttons.set 으로 Webview에 DTO 전송
  - Webview의 button.click {id} 수신 → 공용 디스패처가 실행(op.kind)
       │
       └─(필요시) webview에 ui.toggleMode 등 신호(post)

[panel.ts] (Webview)
  - buttons.set → 섹션 카드 + 버튼 렌더
  - 버튼 클릭 → button.click {id} 전송
  - ui.toggleMode 수신 → mode-normal/debug 토글
```

도메인 로직(연결/파일전송/로그/취소 등)은 **기존 `commandHandlers`**가 그대로 담당합니다.  
버튼은 **트리거**일 뿐이며, 대부분은 `op: {kind: 'line', line: '<console line>'}`으로 `handlers.route()`를 호출합니다.

---

## 2) 빠른 체크리스트 (신규 버튼 추가 전)

- 어떤 **op 타입**인가?
  - `line`: 콘솔 라인(가장 일반적) → 기존 명령 라우터 사용
  - `vscode`: VS Code 명령 실행(창 리로드 등)
  - `post`: Webview UI에 신호만 보냄(예: `ui.toggleMode`)
  - `handler`: Host 단의 특수 처리(정말 필요한 경우만)
- **표시 조건** `when(ctx)` 필요한가? (예: 업데이트 있을 때만)
- **인자**가 필요한가?
  - `line` 끝 공백을 붙여 입력창에 **prefill** 유도(예: `'host '`)
  - 또는 **기존 핸들러**가 인자 없을 때 대화형 입력(폴더 선택 등)
- **실행 시간/취소/진행 표시**가 필요한가? → Host에서 `appendLog`로 단계 로그 남기기
- **보안/검증** 필요한가? (경로/인자 검증은 핸들러 쪽에서 처리 권장)
- 어느 **섹션**에 둘까? (툴 설정 / homey 조작 / host 조작 / Git / 도움말…)

---

## 3) `op.kind` 사용 규칙

- `line`
  - 예: `{ kind: 'line', line: 'homey-restart' }`
  - 인자 입력 유도: `{ kind: 'line', line: 'host ' }`  ← 끝 공백으로 prefill
- `vscode`
  - 예: `{ kind: 'vscode', command: 'workbench.action.reloadWindow' }`
- `post`
  - 예: `{ kind: 'post', event: 'ui.toggleMode', payload: { toggle: true } }`
  - 순수 UI 신호에만 사용(도메인 로직 금지)
- `handler`
  - 예: `{ kind: 'handler', name: 'updateNow' }`
  - Host에서 `_runHandler()`로 분기. 공용 로깅/에러 정책을 따름.

---

## 4) `when(ctx)` 작성

- 순수 동기 함수로 간단하게: `(ctx) => !!ctx.updateAvailable && !!ctx.updateUrl`
- 새 컨텍스트가 필요하면 Host(`extensionPanel.ts`)의 `_sendButtonSections()`에서 `buildButtonContext()` 인자를 확장하세요.

---

## 5) 네이밍 규칙

- `섹션.의도` 형태 권장: `tool.updateNow`, `cmd.homeyRestart`, `ui.toggleMode`
- 라벨은 명확하게, 툴팁(`desc`)에 **언제/무엇을** 설명

---

## 6) 테스트/리뷰 체크리스트

- **렌더**: buttons.set 받은 뒤 섹션 카드에 새 버튼이 보이는가?
- **클릭 경로**: Webview → `button.click {id}` → Host 디스패처 → 기대 동작?
- **표시 조건**: when(ctx) 에 따라 노출/비노출이 올바른가?
- **회귀**: 기존 `commandHandlers` 라우팅과 충돌 없는가?

---

## 7) 예시: 버튼 하나 추가하기

1) `src/extension/commands/edgepanel.buttons.ts`에서 원하는 섹션에 항목 추가:
```ts
{
  id: 'cmd.dockerUpdate',
  label: 'homey-docker-update',
  desc: 'Docker 이미지 업데이트',
  op: { kind: 'line', line: 'homey-docker-update ' }, // 끝 공백: 인자 입력 유도
}
```
2) (선택) 인자가 필요 없게 만들고 싶다면 `commandHandlers.route()`의 해당 명령 구현에서 대화형 입력을 처리한다.  
3) 저장 후 패널 다시 열기(또는 Reload Window).

---

## 8) 파일 관계 요약

- **추가/수정 대부분**: `src/extension/commands/edgepanel.buttons.ts`
- **Host(Extension) 브릿지**: `src/extension/panels/extensionPanel.ts`  
  - DTO 전송(`buttons.set`) / 클릭 수신(`button.click`) / 공용 디스패처
- **Webview 렌더**: `src/ui/edge-panel/index.html`, `panel.ts`, `panel.css`  
  - 카드 렌더링, 버튼 클릭 전달, UI 토글 신호 수신
- **도메인 로직**: `src/extension/commands/commandHandlers.ts` (그대로 사용)

---

## 9) 흔한 실수 방지

- 버튼 추가만 했는데 실행이 안 되면?
  - `op.kind`/필드 오타 확인
  - `when(ctx)`가 false라서 숨겨진 건 아닌지 확인
- `handler`를 남용하지 말 것. 가능한 `line`/`vscode`/`post`로 표현.
- UI 관련 변경은 Webview(post), 도메인 변경은 `commandHandlers`로.
