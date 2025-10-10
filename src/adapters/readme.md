## 3. Adapters (src/adapters/\*\*)

### 개요

**Adapters 레이어**는 Core의 `ExecRunner`를 활용하여  
ADB, SSH 등 **외부 대상 실행 수단**을 구체적으로 래핑한 모듈이다.  
즉, 외부 환경과의 실제 상호작용을 수행하며, Core에서 정의한 공통 추상화 위에 **실행 구체화 계층**을 제공한다.

---

### 주요 기능

#### 1. ADB Adapter

- 안드로이드 디바이스/에뮬레이터와 통신
- `adb -s <serial>` 기반 명령 실행
- `adb shell`, `adb push/pull`, `adb logcat` 등을 ExecRunner로 감쌈
- 옵션: `serial`, `timeoutMs`, `signal` 지원
- 스트리밍 모드(`adbStream`)를 통해 실시간 로그 라인 단위 처리 가능

#### 2. SSH Adapter

- 원격 호스트와의 명령 실행/파일 전송을 담당
- `ssh user@host <command>` 방식 실행을 ExecRunner로 래핑
- 연결 관리(세션, 포트포워딩 등)와 Core connection 계층 연계
- 보안키, 암호 인증 등 다양한 옵션 지원

#### 3. 공통 특성

- Core의 ExecRunner를 기반으로 모든 외부 명령 실행을 일관되게 처리
- stdout/stderr 스트림을 로깅 및 웹뷰 브리지로 전달
- 연결 중단, timeout, abort signal 처리 가능

---

### 디렉터리 구조 (예시)

```
src/
└─ adapters/
├─ adb/
│ └─ adbClient.ts # adb 실행 유틸
├─ ssh/
│ └─ sshClient.ts # ssh 실행 유틸
└─ index.ts # 공용 어댑터 export
```
