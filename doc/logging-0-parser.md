# Log Parser 구성 (v1)

본 문서는 **사용자 정의 파서 JSON**의 구조와 동작, 그리고 EdgeTool이 워크스페이스에서 해당 파일을 **생성/유지/이동**하는 정책을 설명합니다.

## 파일 위치

- 워크스페이스 루트: `<workspace>/`
- 파서 설정: `<workspace>/.config/log_parser.json`
- 템플릿(내장): `media/resources/custom_log_parser.template.v2.json`

> 확장이 활성화되면 현재 워크스페이스에 `.config/log_parser.json`이 없을 경우 **템플릿으로 자동 생성**됩니다.  
> 사용자가 버튼 **"Parser 초기화"** 를 누르면 기존 내용을 **덮어쓰고 템플릿으로 재생성**합니다.

## 워크스페이스 이동/교체 시 정책

작업폴더를 변경했는데 새 워크스페이스에 `.config/` 가 없으면:
1) **이전 워크스페이스의 `.config` 폴더를 통째로 복사**합니다.
2) 이전 폴더도 더 이상 사용하지 않는다면 사용자가 삭제할 수 있습니다. (툴은 삭제하지 않습니다)
3) 이전 폴더에 `.config`가 없으면 **템플릿으로 시드**합니다.

이 로직은 내부 모듈 `parserConfigSeeder`가 담당합니다.

---

## JSON 스키마 (v1)

```jsonc
{
  "version": 1,
  "requirements": {
    "fields": {
      "time": true,
      "process": true,
      "pid": true,
      "message": true
    }
  },
  "preflight": {
    "sample_lines": 200,
    "min_match_ratio": 0.8,
    "hard_skip_if_any_line_matches": [
      "^=+\[^)]*\=+$",
      "^(WIFI|BT|CLIP)==>"
    ]
  },
  "parser": [
    {
      "files": ["**/kernel.log*", "**/system.log*"],
      "line_regex": "^(?<time>[A-Z][a-z]{2}\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2})\\s+(?<process>[\\w.-]+)\(?<pid>\\d+)\:\\s+(?<message>.+)$",
      "time_parse": {
        "type": "strftime",
        "format": "MMM d HH:mm:ss",
        "assume_tz": "UTC",
        "assume_year": "current"
      }
    },
    {
      "files": ["**/bt_player.log*"],
      "line_regex": "^(?<time>\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3})\\s+(?<process>bt_player)\(?<pid>\\d+)\\\s+-\\s+(?<message>.+)$",
      "time_parse": {
        "type": "strftime",
        "format": "yyyy-MM-dd HH:mm:ss.SSS",
        "assume_tz": "UTC"
      }
    }
  ]
}
```

### 1) `version`
- 스키마 진화(필드 추가/이름 변경 등)를 고려한 **호환성 플래그**입니다.
- 도구는 `version`을 확인하여 지원 범위를 벗어나는 경우 경고할 수 있습니다. (현재 1만 사용)

### 2) `requirements.fields`
- 각 로그 라인에서 **필수로 파싱되어야 할 필드**를 지정합니다.
- 현행 정책상 `time`, `message`, `process`, `pid` **모두 `true`** 입니다.
- 파싱 실패 시 해당 라인은 **드롭**하거나 **비워두기** 정책을 적용할 수 있습니다(도구 구현에 따름).

### 3) `preflight`
- 파일 단위 **사전 검사 규칙**입니다.
- `sample_lines` 만큼 샘플링하여 `min_match_ratio` 이상 정규식 매칭이 발생하지 않으면 **해당 파일을 스킵**합니다.
- `hard_skip_if_any_line_matches` 중 **하나라도** 매칭되면 해당 파일은 **즉시 스킵**됩니다.
  - 예: `==========(Dec 24 10:50:43)=========` 혹은 `WIFI==>`, `BT==>`, `CLIP==>` 헤더 등의 파일

### 4) `parser[]`
- 파일 글로브(`files`)와 라인 정규식(`line_regex`), 시간 파싱(`time_parse`)을 묶어 **파서 엔트리**를 정의합니다.
- `line_regex`는 **명명된 캡처 그룹**을 사용합니다: `?<time>`, `?<process>`, `?<pid>`, `?<message>`
- `time_parse`:
  - `type: "strftime"` — `format`은 해당 타입의 포맷 문자열을 사용
  - `assume_tz`: 로그에 타임존 정보가 없을 때 가정할 시간대(e.g., `"UTC"`)
  - `assume_year`: 연도 정보가 없으면 `"current"` 등으로 보정

---

## UI/명령

- **버튼**: "작업폴더 ▸ Parser 초기화" — `.config/log_parser.json`을 템플릿으로 **재생성**합니다.
- **활성화 시 자동 시드**: `.config/log_parser.json`이 없으면 템플릿으로 생성합니다.
- **작업폴더 변경 시 마이그레이션**: 새 워크스페이스에 `.config`가 없으면 이전 워크스페이스의 `.config` 폴더를 복사합니다. 이전에도 없으면 템플릿으로 생성합니다.

---

## FAQ

**Q. 사용자가 실수로 `.config/log_parser.json`을 지웠어요.**  
A. 버튼 "Parser 초기화"를 눌러 템플릿으로 재생성하면 됩니다. 또는 확장을 다시 활성화해도 자동 시드됩니다.

**Q. `version` 필드는 왜 필요하죠?**  
A. 앞으로 스키마를 확장할 때 하위 호환/마이그레이션을 제어하기 위해 사용합니다.

**Q. 정규식이 너무 복잡합니다.**  
A. 정규식은 템플릿을 그대로 사용해도 되고, 파일별로 `files` 글로브와 `line_regex`를 사용자 환경에 맞게 줄일 수도 있습니다. 단, `requirements.fields`에 지정된 필드는 반드시 캡처되어야 합니다.

**Q. 프리플라이트에서 스킵된 파일은 어디서 확인하나요?**  
A. 병합 로그/호스트 로그에 **스킵 이유**가 출력되도록 구현됩니다("hard-skip pattern matched", "low match ratio" 등).

---

## 추후 계획

- `preflight`에 **샘플 포맷 자동 감지** 보강
- `time_parse`의 타입 추가 (`iso8601` 등)
- 파서 에러 리포트(파일별 매칭률, 드롭 라인 수) 요약 제공
