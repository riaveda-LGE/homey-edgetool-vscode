# Homey EdgeTool

Homey Edge Tool 콘솔 및 로깅을 위한 VS Code 확장입니다.

## 기능

- Homey 장치로부터 실시간 로그 모니터링
- SSH/ADB 연결 지원
- 로그 파일 통합 및 병합
- 타임존 점프 감지 및 보정
- 성능 모니터링

## 설치

1. 저장소를 클론합니다
2. `npm install`을 실행합니다
3. 확장을 빌드합니다: `npm run build`
4. VS Code에서 `.vsix` 파일을 설치합니다

## 사용법

### 개발 모드 (EDH - Extension Development Host)

개발 중 핫 리로드를 활성화하려면:

```bash
npm run dev
```

이 명령은 라이브 리로딩이 가능한 개발 모드로 확장을 시작합니다.

### 프로덕션 빌드

```bash
npm run deploy
```

### 테스트

모든 테스트 실행:

```bash
npm test
```

특정 테스트 실행:

```bash
# 일반 로그 파일 병합 테스트
npm test -- --testNamePattern="일반 로그 파일들을 정확히 병합해야 함"

# 타임존 점프 로그 병합 테스트
npm test -- --testNamePattern="타임존 점프가 있는 로그 파일들을 정확히 병합해야 함"
```

## 스크립트

- `npm run clean`: dist 디렉토리 정리
- `npm run lint`: ESLint 실행
- `npm run format`: Prettier와 ESLint로 코드 포맷팅
- `npm run test`: Jest 테스트 실행
- `npm run build`: 확장 빌드
- `npm run package`: 확장 패키징
- `npm run deploy`: 확장 배포
