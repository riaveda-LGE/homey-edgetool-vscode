# Homey EdgeTool — homey-logging 모드 구현 상태 및 추가 작업 정리

## 1. 현재 동작
Edge Panel에서 homey-logging 실행 → 실시간/파일병합 모드 선택 →
파일병합 선택 시 폴더 다이얼로그 → 병합 진행 → 로그 뷰 표시(Custom Editor).

---

## 2. 구현 상태

### ✅ 구현 완료
- 모드 선택/폴더 선택 UX
- 파일 병합 진입 & 스트리밍 표시 (기본 200행 배치)
- 실시간 로그 스트림 (ADB logcat / SSH journalctl)
- 프로세스/취소 관리 (SIGTERM → SIGKILL 폴백)
- tar/base64 SSH/ADB 파일 전송
- 로깅/업데이트/Edge Panel 로그 복원
- 디바이스 리스트 CRUD

### 🧩 구현 필요
- k-way merge (시간 교차 병합, 역/정순 옵션)
- 타임존 점프/오프셋 보정
- 초기 스냅샷 + 스트리밍 분리
- postMessage 배치 + ACK 백프레셔
- 가상 스크롤/DocumentFragment/워커 파싱
- HybridLogBuffer 4-버퍼 완성
- LogFileStorage JSONL/gzip + 범위 조회
- 검색/필터/하이라이트/북마크
- Edge Panel 메트릭 차트화

### ✍️ 구현 수정 필요
- mergeDirectory 단순 파일 순차 읽기 → k-way 병합 필요
- 실시간 1줄 전송 → 배치화 필요
- Date.now() ID 충돌 → seq 기반 ID로 교체
- HostWebviewBridge 미적용 → EdgePanel/LogViewer 통일
- HomeyController mount/unmount/git 실제화
- SSH password 인증 경로 추가 필요

---

## 3. 커스텀 에디터 UX 체크리스트
- Ctrl+F 검색/정규식/범위
- 가상 스크롤 + 하단 자동 스크롤
- 하이라이트/북마크/툴팁/복사
- 총 행/필터 후 개수/초당 유입/메모리 통계
- 배치 렌더 + ACK 후 호스트 재전송

---

## 4. 우선순위
1. 배치+ACK 백프레셔 공통 적용
2. k-way 병합 + 타임존 보정
3. 가상 스크롤 + 초기 스냅샷 분리
4. HostWebviewBridge 통일
5. 검색/북마크/툴팁 단계적 추가
