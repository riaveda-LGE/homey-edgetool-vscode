# Logging 4: 웹뷰어 표시 및 기능 (UI 컴포넌트)

## 📁 관련 파일
```bash
src/webviewers/log-viewer/react/store.ts
src/webviewers/log-viewer/react/components/Grid.tsx
src/webviewers/log-viewer/react/components/SearchPanel.tsx
src/webviewers/log-viewer/react/components/FilterBar.tsx
src/webviewers/log-viewer/react/ipc.ts
```

## 🔄 로직 플로우

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
