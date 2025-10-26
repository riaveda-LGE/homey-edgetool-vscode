Log Parser 구성 (v1)

본 문서는 사용자 정의 파서 JSON의 구조와 동작, 그리고 EdgeTool이 워크스페이스에서 해당 파일을 생성/유지/이동하는 정책을 설명합니다. (코드 기준: v1)


---

파일 위치

워크스페이스 루트: <workspace>/

파서 설정(실제 사용 파일): <workspace>/.config/custom_log_parser.json

내장 템플릿(JSON): media/resources/custom_log_parser.template.v1.json

내장 README 템플릿: doc/logging-0-parser.md


> 확장이 활성화되면 현재 워크스페이스에 .config/custom_log_parser.json이 없을 경우 템플릿으로 자동 생성됩니다.
명령/버튼 "Parser 초기화" 를 실행하면 기존 내용을 덮어쓰고 템플릿으로 재생성합니다. (README도 함께 재생성)




---

워크스페이스 이동/교체 시 정책

작업폴더를 변경했는데 새 워크스페이스에 .config/ 가 없으면:

1. 이전 워크스페이스의 .config 폴더를 통째로 복사합니다.


2. 새 워크스페이스에 .config 가 이미 있으면 복사를 생략합니다.


3. 이전 워크스페이스에 .config 가 없으면 템플릿으로 시드합니다.


4. 이전 워크스페이스의 .config 폴더는 도구가 정리(삭제)합니다. (코드 현재 동작)



이 로직은 내부 모듈 parserConfigSeeder 가 담당합니다.


---

JSON 스키마 (v1)

> 아래 스키마는 현재 구현과 일치합니다. (단일 line_regex 나 time_parse 키는 지원하지 않습니다.)


```bash
{
  "version": 1,
  "requirements": {
    "fields": {
      "time": true,
      "process": true,
      "pid": false,
      "message": true
    }
  },
  // 프리플라이트 매칭 비율 계산 시 "필수로 있어야 한다"고 간주할 필드
  "preflight": {
    // 각 파일에서 읽어볼 샘플 라인 수
    "sample_lines": 200,
    // 샘플 중 필수 필드들이 충족된 라인의 비율이 이 값 미만이면 해당 파일에 커스텀 파서를 적용하지 않음
    "min_match_ratio": 0.8,
    // 아래 패턴 중 하나라도 샘플에서 매칭되면 즉시 스킵(커스텀 파서 미적용)
    "hard_skip_if_any_line_matches": [
      "^=+\\([^)]*\\)=+$",
      "^(WIFI|BT|CLIP)==>"
    ]
  },
  "parser": [
    { 
      "file": "system.log.{n}",
      "need" : true,
      "regex": {
        "time": "^\\[(?<time>(?:[A-Z][a-z]{2})\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3,6})?)\\]",
        "process": "^\\[[^\\]]+\\]\\s+(?<process>[A-Za-z0-9._-]+)(?=\\[|:)",
        "pid": "^\\[[^\\]]+\\]\\s+[A-Za-z0-9._-]+(?:\\[(?<pid>\\d+)\\])?:",
        "message": "^\\[[^\\]]+\\]\\s+[A-Za-z0-9._-]+(?:\\[\\d+\\])?:\\s+(?<message>.+)$"
      }
    },
    ...
  ]
}
```

키 설명

1. version

스키마 진화(필드 추가/이름 변경 등)를 고려한 호환성 플래그입니다. 현재는 1만 지원합니다.


2. requirements.fields (프리플라이트 전용)

파일 단위 사전 검사에서 매칭 비율을 계산할 때 반드시 있어야 한다고 간주할 필드를 지정합니다.

현재 구현은 프리플라이트 판단에만 사용되며, 실제 병합 시 라인을 드롭하지는 않습니다. (필드가 없어도 라인은 그대로 병합됩니다)

3. preflight

파일별 사전 검사 규칙입니다.

sample_lines: 앞쪽 일부 라인을 읽어 샘플로 사용

hard_skip_if_any_line_matches: 하나라도 매칭되면 해당 파일은 커스텀 파서 미적용

min_match_ratio: 필수 필드 충족 라인 비율이 미만이면 커스텀 파서 미적용


커스텀 파서 미적용 시에는 기존 휴리스틱 로직으로 병합됩니다:
- **타임스탬프 추정**: `TimeParser.ts`의 `parseTs()` 함수로 라인 전체에서 시간 패턴 탐색
- **레벨 추정**: `guessLevel()` 함수로 ERROR/WARN/INFO/DEBUG 레벨 자동 판별  
- **타입 분류**: system/homey/application/other 중 하나로 자동 분류
- **메시지 추출**: 전체 라인을 메시지로 사용 (별도 파싱 없음)


4. parser[]
## 1) 설정 스키마

```jsonc
{
  "file": "system.log.{n | 0 | K | :K}",
  "need": true | false,
  "regex": {
    "time":    "<REGEX>",
    "process": "<REGEX>",
    "pid":     "<REGEX>",
    "message": "<REGEX>"
  }
}
```
- 여러 파일군을 정의하려면 위 블록을 배열로 나란히 나열합니다.

### 필드 설명
- **file**: 로테이션 세트를 나타내는 패턴. `system.log.{...}` 처럼 **basename + .log + {선택자}** 형식.
- **need**: 이 항목을 **파싱에 포함(true)** / **완전히 무시(false)**.
- **regex**: 각 라인의 `time / process / pid / message`를 추출하는 정규식. 기존 규칙과 동일.

---

## 2) 파일 선택자 문법 (`{}` 내부)

`{}`에는 아래 중 하나가 올 수 있습니다.

- `n` : **모든 로테이션 파일 포함**
  - 예: `system.log`, `system.log.1`, `system.log.2`, …
- `0` : **베이스 파일만 포함**
  - 예: `system.log`
- `K` (정수): **정확히 해당 로테이션 번호만 포함**
  - 예: `7` → `system.log.7` (K>0), `0`은 `system.log`와 동일
- `:K` : **최신부터 K까지 구간 포함(포함 범위)**
  - 예: `:2` → `system.log`, `system.log.1`, `system.log.2`

> ⚠️ 존재하지 않는 파일은 **조용히 건너뜁니다**(누락 허용). 검색은 **루트(비재귀)** 기준으로 수행합니다.

---

FAQ

Q. .config/custom_log_parser.json 을 지웠습니다.
A. 명령 "Parser 초기화" 를 실행해 템플릿으로 재생성하세요. 확장을 다시 활성화해도 자동 시드됩니다.

Q. version 필드는 왜 필요하죠?
A. 앞으로 스키마를 확장할 때 하위 호환/마이그레이션을 제어하기 위해 사용합니다.

Q. 정규식이 너무 복잡합니다.
A. 템플릿을 그대로 사용해도 되며, 파일별로 files 글로브와 regex 를 환경에 맞게 줄일 수 있습니다. 단, requirements.fields 로 지정된 필드는 프리플라이트 판단에서 필수로 취급됩니다.

---