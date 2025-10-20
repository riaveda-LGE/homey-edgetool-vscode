# 스크롤 이동에 따른 가상 스크롤 인덱스 재매핑 로직

## 📁 관련 파일
```bash
src/webviewers/log-viewer/react/store.ts
src/webviewers/log-viewer/react/components/Grid.tsx
src/webviewers/log-viewer/react/components/SearchPanel.tsx
src/webviewers/log-viewer/react/components/FilterDialog.tsx
src/webviewers/log-viewer/react/ipc.ts
```

## 🔄 로직 플로우

### 가상 스크롤 데이터 윈도우 이동 시 스크롤 위치 자동 동기화 메커니즘

가상 스크롤에서 스크롤 이벤트 발생 시 데이터 로딩 → `windowStart` 업데이트 → `scrollTop` 자동 조정 → 인덱스 재매핑의 과정을 설명합니다.

#### 변수 정의
- **windowStart**: 현재 로드된 데이터의 시작 인덱스 (1-based, 예: 45이면 45번째 로그부터 로드됨)
- **bufferStart0**: `windowStart - 1` (0-based 변환, 예: 44)
- **scrollTop**: 스크롤 컨테이너의 실제 스크롤 위치 (픽셀)
- **v.index**: 가상 스크롤에서 각 행의 인덱스 (0-based, 스크롤 위치에 따라 계산됨)
- **offset**: `v.index - bufferStart0` (로드된 데이터 배열의 인덱스)
- **r**: 렌더링할 로그 행 (`offset` 유효 시 `visibleRows[offset]`, 아니면 `undefined` → placeholder)

#### 단계별 변수 변화 비교 표

**가정 조건:**
- rowH = 20px (행 높이)
- windowSize = 25 (한 번에 로드하는 행 수)
- 초기: windowStart=1, scrollTop=0
- 스크롤 이벤트: 사용자가 스크롤을 내림, scrollTop=1000px (약 50행 분량)
- 데이터 로드: windowStart=45 (45번째 행부터 로드)

| 단계 | windowStart | bufferStart0 | scrollTop | v.index (예) | offset | r | 설명 |
|------|-------------|--------------|-----------|--------------|--------|---|------|
| **초기** | 1 | 0 | 0 | 0 | 0 | visibleRows[0] | 초기 로드, 첫 번째 행 표시. 정상. |
| **스크롤 중 (데이터 요청 전)** | 1 | 0 | 1000 | 50 (1000/20) | 50 | visibleRows[50] | 스크롤 위치 바뀌었지만 데이터 아직 로드 안 됨. 로드된 범위(1-25) 안이라 정상 표시. |
| **데이터 로드 후 (패치 적용 전)** | 45 | 44 | 1000 (그대로) | 50 | 50-44=6 | visibleRows[6] | windowStart 업데이트됐지만 scrollTop 그대로. v.index=50이 windowStart=45 기준으로 offset=6, 정상 표시. (문제 없음) |
| **더 스크롤 (문제 발생 시점)** | 45 | 44 | 2000 | 100 (2000/20) | 100-44=56 | undefined (56 >= 25) | 스크롤 더 내림, v.index=100, offset=56 > 로드된 범위(25), r=undefined → placeholder만 렌더링 → 빈 화면 (로그 사라짐). |
| **패치 적용 후** | 45 | 44 | 2000 + (45-1)*20 = 2000+880=2880 | 144 (2880/20) | 144-44=100 | visibleRows[100] | windowStart 변경 시 scrollTop += delta*rowH, 이제 v.index가 올바른 범위 가리킴. 정상 표시. |

#### 문제 해결 패치
`Grid.tsx`에 `useEffect` 추가로 `windowStart` 변경 시 `scrollTop`을 자동 조정:
```tsx
const prevWindowStartRef = useRef(m.windowStart);
useEffect(() => {
  const prev = prevWindowStartRef.current;
  const curr = m.windowStart;
  if (prev !== curr && parentRef.current) {
    const delta = curr - prev;
    const scrollDelta = delta * m.rowH;
    parentRef.current.scrollTop += scrollDelta;
    ui.info(`Grid.windowStart changed ${prev}→${curr}, scrollTop += ${scrollDelta}`);
  }
  prevWindowStartRef.current = curr;
}, [m.windowStart, m.rowH, ui]);
```

### 상태 관리
- **Zustand 스토어**: `useLogStore`로 전역 상태 관리
- **배치 누적**: `receiveRows()`로 새 데이터 추가
- **필터 적용**: `applyFilter()`로 표시 행 재계산
- **검색 처리**: `setSearchResults()`로 히트 결과 저장
- **북마크 관리**: `toggleBookmark()`로 행 즐겨찾기

### 가상 스크롤 그리드
- **렌더링 최적화**: `LOG_WINDOW_SIZE` 범위만 DOM 생성
- **컬럼 관리**: time/proc/pid/src/msg 컬럼 폭/표시 토글
- **행 인터랙션**: hover/선택/더블클릭 북마크
- **스크롤 트리거**: 하단 임계 시 `requestMore` IPC 발신

### 검색 기능
- **텍스트 검색**: 실시간 하이라이트 + 네비게이션
- **결과 표시**: X/Y 형식으로 히트 수/총계 표시
- **키보드 제어**: Ctrl+F 토글, ↑↓ 이동, Esc 닫기
- **필터 연동**: 검색어 + 필터 조건 복합 적용

### 필터링 UI
- **칩 기반 입력**: PID/src/proc/msg 필드별 토큰 입력
- **실시간 적용**: 입력 시 즉시 필터 재계산
- **초기화 지원**: 전체 필터 클리어 버튼
- **시각적 피드백**: 활성 필터 칩 하이라이트

### 렌더링 최적화
- **Virtualized List**: 수만 행도 부드러운 스크롤
- **Web Worker**: 무거운 파싱을 백그라운드 처리
- **배치 업데이트**: DocumentFragment로 DOM 조작 최소화
- **메모리 관리**: 표시 범위 외 데이터 자동 해제
