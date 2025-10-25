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
      // 이 규칙이 적용될 파일 글로브(화이트리스트)
      "files": [
        "^system\\.log(?:\\.\\d+)?$",
        "^clip\\.log(?:\\.\\d+)?$",
        "^cpcd\\.log(?:\\.\\d+)?$",
        "^homey-pro\\.log(?:\\.\\d+)?$",
        "^matter\\.log(?:\\.\\d+)?$",
        "^otbr-agent\\.log(?:\\.\\d+)?$",
        "^z3gateway\\.log(?:\\.\\d+)?$"
      ],
      // 각 필드를 개별 정규식으로 캡처(반드시 named capture 사용: (?<time>...), (?<process>...) 등)
      // 아래는 실제 템플릿의 정규식 예시 (media/resources/custom_log_parser.template.v1.json 참고)
      "regex": {
        "time": "^\\[(?<time>(?:[A-Z][a-z]{2})\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3,6})?)\\]",
        "process": "^\\[[^\\]]+\\]\\s+(?<process>[A-Za-z0-9._-]+)(?=\\[|:)",
        "pid": "^\\[[^\\]]+\\]\\s+[A-Za-z0-9._-]+(?:\\[(?<pid>\\d+)\\])?:",
        "message": "^\\[[^\\]]+\\]\\s+[A-Za-z0-9._-]+(?:\\[\\d+\\])?:\\s+(?<message>.+)$"
      }
    },
    {
      "files": ["^kernel\\.log(?:\\.\\d+)?$"],
      "regex": {
        "time": "^\\[(?<time>(?:[A-Z][a-z]{2})\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3,6})?)\\]",
        "process": "^\\[[^\\]]+\\]\\s+(?<process>kernel)(?=:)",
        "pid": "^\\[[^\\]]+\\]\\s+kernel(?::)",
        "message": "^\\[[^\\]]+\\]\\s+kernel:\\s+(?<message>.+)$"
      }
    },
    {
      "files": ["^bt_player\\.log(?:\\.\\d+)?$"],
      "regex": {
        "time": "^\\[(?<time>(?:[A-Z][a-z]{2})\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3,6})?)\\]",
        "process": "^\\[[^\\]]+\\]\\s+(?<process>[A-Za-z0-9._-]+)(?=\\[|:)",
        "pid": "^\\[[^\\]]+\\]\\s+[A-Za-z0-9._-]+(?:\\[(?<pid>\\d+)\\])?:",
        "message": "^\\[[^\\]]+\\]\\s+[A-Za-z0-9._-]+(?:\\[\\d+\\])?:\\s+(?<message>.+)$"
      }
    }
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

files: 이 규칙을 적용할 파일 글로브(화이트리스트) 목록입니다. 병합 수집 단계에서 우선 이 글로브로 필터링됩니다.

regex: 각 필드를 개별 정규식으로 지정하며, 반드시 명명된 캡처 그룹을 사용합니다. (예: (?<time>...))

캡처된 process/pid/message 는 UI 컬럼/검색 보조에 사용됩니다.


> 참고: 현재(ts 계산)는 내부 파서가 라인 전체에서 시간을 추정합니다. regex.time 캡처는 프리플라이트와 UI 보강용이며, 직접적으로 타임스탬프 계산을 대체하지 않습니다. (추후 확장 예정)
---

UI/명령

버튼/명령: "작업폴더 ▸ Parser 초기화" — .config/custom_log_parser.json 과 .config/custom_log_parser_readme.md 를 템플릿으로 재생성합니다.

활성화 시 자동 시드: .config/custom_log_parser.json 이 없으면 템플릿으로 생성합니다.

작업폴더 변경 시 마이그레이션: 새 워크스페이스에 .config 가 없으면 이전 워크스페이스의 .config 폴더를 복사하고, 이전 폴더의 .config 는 도구가 제거합니다.



---

FAQ

Q. .config/custom_log_parser.json 을 지웠습니다.
A. 명령 "Parser 초기화" 를 실행해 템플릿으로 재생성하세요. 확장을 다시 활성화해도 자동 시드됩니다.

Q. version 필드는 왜 필요하죠?
A. 앞으로 스키마를 확장할 때 하위 호환/마이그레이션을 제어하기 위해 사용합니다.

Q. 정규식이 너무 복잡합니다.
A. 템플릿을 그대로 사용해도 되며, 파일별로 files 글로브와 regex 를 환경에 맞게 줄일 수 있습니다. 단, requirements.fields 로 지정된 필드는 프리플라이트 판단에서 필수로 취급됩니다.

Q. 프리플라이트에서 스킵된 파일은 어떻게 확인하나요?
A. 현재는 내부 로그로 확인할 수 있습니다. (스킵 사유 메시지 보강은 추후 제공 예정)


---

구현 현황 체크리스트 (코드 기준)

경로 상수: .config/custom_log_parser.json / .config/custom_log_parser_readme.md

내장 템플릿: media/resources/custom_log_parser.template.v1.json

README 템플릿: doc/logging-0-parser.md

초기화 명령: 템플릿/README 강제 재생성 (덮어쓰기)

마이그레이션: 이전 워크스페이스 .config → 새 워크스페이스 .config 복사(만약 새 워크스페이스에 .config가 이미 있을 경우 복사X), 이전 것은 삭제 처리

런타임 동작:

글로브 화이트리스트 수집 → 타입 그룹화 → 타임존 보정 → JSONL 중간 산출 → k-way 병합

커스텀 파서가 있으면 파일별 preflight 후 process/pid/message 등 UI 보강 필드 추출

커스텀 파서 미적용/부재 시 기존 휴리스틱으로 안전 폴백