# Core Services & Tools (src/core/**)

## 개요
**Core 레이어**는 VS Code Extension Host에서 사용하는 공용 서비스와 유틸리티를 제공한다.  
Node.js 런타임에서 동작하며, 프로세스 실행·연결 추상화·로그 관리·파일 조작 등 **도메인 로직의 핵심**을 담당한다.

---

## 주요 기능

### 1. 프로세스 실행 (Process Execution)
- 외부 명령어 실행 (`child_process.spawn`, `exec`) 래핑
- 비동기 실행, 시간 제한(`timeoutMs`), AbortSignal 지원
- 표준 출력/에러 스트림 콜백 제공
- 예: `ExecRunner.runCommandLine(cmd, opts)`

### 2. 연결 추상화 (Connection Abstraction)
- ADB, SSH 등 외부 호스트 연결을 위한 추상 계층
- 재연결, 시그널 처리, 연결 상태 관리
- 상위 모듈에서 동일 인터페이스로 다양한 연결 방식 사용 가능

### 3. 로그 버퍼 (Log Buffer)
- 실시간 로그 스트림을 버퍼링하여 나중에 조회 가능
- 웹뷰 초기 로드 시 과거 로그를 복원
- `addLogSink` / `removeLogSink` / `getBufferedLogs` 형태로 관리

### 4. 파일 병합 및 검색 (File Utilities)
- 여러 파일을 병합하거나 특정 패턴으로 검색하는 기능
- 대규모 로그/설정 파일 처리 시 활용
- 경로/인코딩 처리까지 포함한 범용 유틸리티 제공

---

## 디렉터리 구조 (예시)
```
src/
└─ core/
├─ connection/ # ADB/SSH 등 연결 추상화 계층
│ └─ ExecRunner.ts # 프로세스 실행 유틸
├─ logger/ # 로그 버퍼 및 로깅 유틸
├─ file/ # 파일 병합/검색 기능
└─ util/ # 공통 헬퍼 함수
```