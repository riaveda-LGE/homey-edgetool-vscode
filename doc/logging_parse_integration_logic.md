# Homey EdgeTool — 로그 파이프라인 점검 결과 (updated 2025-10-24)

> 목적: 사용자가 요약한 파이프라인(커스텀 파서 → 타입별 버퍼/정렬 → 타임존 보정 → 통합 병합 ↓ → 페이지 서비스(오름차순 매핑) → 웹뷰 전달)이 **첨부 코드**에 실제로 구현되어 있는지 확인하고, 핵심 근거와 흐름을 간결하게 정리.

---

## 1) 커스텀 파서 적용
- **구성 파일/시드**
  - `PARSER_TEMPLATE_REL = media/resources/custom_log_parser.template.v1.json` → 워크스페이스에 `.config/custom_log_parser.json`으로 시딩: `src/extension/setup/parserConfigSeeder.ts`
- **동작 핵심**
  - 파서 스키마: `src/core/config/schema.ts` (`ParserRequirements`, `ParserPreflight`, `ParserConfig`)
  - 엔진: `src/core/logs/ParserEngine.ts`
    - `compileParserConfig()`로 JSON 규칙 컴파일
    - `shouldUseParserForFile()` / `preflight`로 샘플 매칭률·하드스킵 규칙 평가
    - `lineToEntryWithParser()`에서 정규식 캡처로 **헤더 필드(time/process/pid/message) 파싱** 후, `parseTs()`/`guessLevel()`로 정규화
    - 타이브레이커 메타: `_fRank`, `_rev` 부여(후술 k‑way 병합 시 안정 정렬 근거)

**판정:** ✅  커스텀 파서 파일을 읽어 적용하고, 라인 단위로 헤더 필드를 파싱하는 구현이 확인됨.

---

## 2) 로그 타입별 수집 및 내림차순 정렬
- **타입 그룹화/내림차순 수집**
  - `src/core/logs/LogFileIntegration.ts`
    - 입력 파일 수집 후 `groupByType(files)`로 타입별 그룹 생성
    - **최신 → 오래된** 순으로 각 타입 로그를 메모리에 적재
- **보조 스토어/인덱스**
  - `IndexedLogStore.ts`, `LogFileStorage.ts`, `ChunkWriter.ts`, `ManifestWriter.ts` (후술 통합 병합/청크/매니페스트 단계에서 사용)

**판정:** ✅  타입별 버퍼링과 “최신→오래된(내림차순)” 처리 흐름이 코드 주석·루틴에서 확인됨.

---

## 3) 타임존 점프 감지 및 보정
- **휴리스틱 보정기**
  - `src/core/logs/time/TimezoneHeuristics.ts` (`TimezoneCorrector`)
    - 병합 가정: “**최신 → 오래된**” 순
    - 급격한 오프셋 점프(임계 이상 시간 변화) 탐지 → 복귀 구간 확인 시 **국소 소급 보정(Δoffset)** 적용
    - 보정 세그먼트는 drain 후 병합 시 반영
- **타임 파싱**
  - `src/core/logs/time/TimeParser.ts`의 `parseTs()` 등으로 기본 파싱/정규화

**판정:** ✅  점프 감지 및 국소 보정 로직이 존재하며 병합 흐름에 연결됨.

---

## 4) 통합 버퍼에 내림차순 병합(k‑way)
- **핵심 구현**
  - `src/core/logs/LogFileIntegration.ts`
    - 타입별 정렬/보정 완료 후 **우선순위 큐 기반 k‑way merge**로 단일 스트림 생성(최신→오래된)
    - `ChunkWriter`로 **NDJSON 청크** 단위 저장, `ManifestWriter`가 전역 **매니페스트**(`LogManifest`) 작성
    - tie‑break에 `_fRank`, `_rev` 활용(파일 순서/역인덱스 등) → 안정·결정적 병합
- **결과 스냅샷/인덱싱**
  - `ManifestTypes.ts`, `IndexedLogStore.ts`로 **전역 라인 인덱스**/파일 세그먼트 기록

**판정:** ✅  내림차순(최신 우선) 통합 병합과 청크/매니페스트 저장 구조가 확인됨.

---

## 5) PaginationService: 오름차순 매핑 후 전달
- **페이지 리더**
  - `src/core/logs/PagedReader.ts`: 매니페스트 기반으로 **청크 범위 읽기**
- **페이지 서비스**
  - `src/core/logs/PaginationService.ts`:
    - 전역 총량/필터 캐시 관리
    - **요청된 범위에 대해 “내림차순 저장본”을 “오름차순 좌표계”로 매핑**해 반환
    - 필터가 있으면 **오름차순 인덱스**를 기준으로 부분 집합 계산
- **웹뷰 계약**
  - `src/ipc/messages.ts`:
    - `LogEntry.id`: “**오름차순(과거=1, 최신=total)**” 명시 — UI/브리지는 항상 오름차순 좌표계를 사용
  - `src/webviewers/log-viewer/react/ipc.ts`:
    - 코멘트: “표시 순서는 오름차순, 최신에 초점 → ‘마지막 페이지’를 요청”

**판정:** ✅  저장은 내림차순이지만, **전달은 오름차순 매핑**으로 이뤄짐이 타입/주석/계약에서 명시됨.

---

## 6) 웹뷰 동작 개요
- 초기 상태/프리페치(워밍업)는 `HostWebviewBridge` ↔ `LogViewerPanelManager`로 라우팅
- 웹뷰는 특정 범위 페이지를 요청 → **오름차순으로 정렬된 LogEntry[]** 수신 후 렌더
  - UI 상태 관리: `react/store.ts`(Zustand), 가상 스크롤/그리드: `react/components/Grid.tsx`

**판정:** ✅  “범위 요청 → 오름차순 데이터 수신 → 렌더” 흐름 일치.

---

## 결론 (요약)
- 커스텀 파서 JSON을 읽어 **헤더 파싱** → **타입별 최신순 수집** → **타임존 점프 보정** → **k‑way 내림차순 병합 + 청크/매니페스트** → **PaginationService가 요청 시 오름차순으로 매핑해 전달** → **웹뷰는 오름차순으로 표시**  
→ **사용자 설명과 구현이 실질적으로 일치**합니다.

### 부록: 빠른 근거 맵
- 시드/경로: `const.ts`(PARSER_*), `parserConfigSeeder.ts`
- 파서: `ParserEngine.ts`, `schema.ts`, `TimeParser.ts`
- 병합: `LogFileIntegration.ts`, `ChunkWriter.ts`, `ManifestWriter.ts`, `ManifestTypes.ts`, `IndexedLogStore.ts`
- 보정: `TimezoneHeuristics.ts`
- 페이징: `PaginationService.ts`, `PagedReader.ts`
- 계약/웹뷰: `messages.ts`, `extension/messaging/hostWebviewBridge.ts`, `webviewers/log-viewer/react/ipc.ts`, `react/store.ts`, `react/components/*.tsx`
