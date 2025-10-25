# Homey EdgeTool — 계측(Measure) 치트시트

## 0) 개요
- **목표**: 코드 전반(클래스 메서드, 전역/콜백/웹뷰, 파일 I/O)을 *한 번에* 계측하고, 보고서(JSON/HTML)로 저장.
- **오버헤드**: 캡처 **OFF**일 땐 거의 0에 가깝게 설계. 캡처 **ON**일 때만 수집.

---

## 1) 빠른 시작(Quick Start)
1. **핵심 메서드**엔 `@measure()` 데코레이터를 붙인다.  
2. **전역/콜백/화살표 함수**는 `measured / measuredAsync`로 감싼다.  
3. **웹뷰(UI)**에선 `createUiMeasure(vscode)`로 버튼/연산을 감싼다.  
4. **Perf Monitor 패널**에서 `Start Capture` → 사용 시나리오 실행 → `Stop Capture` → `Export JSON/HTML`.

> JSON에는 모든 분석 데이터(`functionSummary`, `ioAnalysis`, `samples`, `insights` 등)가 포함됨.

---

## 2) 무엇을 언제 쓰나(상황별 가이드)

### A. 클래스 메서드: `@measure(name?)`
```ts
class Parser {
  @measure()
  run(input: string) { /* ... */ }

  @measure("Parser.parseLine")
  parseLine(line: string) { /* ... */ }
}
```
### B. 전역 , 화살표, 콜백:  measured / measuredAsync
```ts
export const normalize = measured("normalize", function normalize(s: string){ /*...*/ });
export const loadConfig = measuredAsync("loadConfig", async function loadConfig(p: string){ /*...*/ });
arr.map(measured("arr.map:normalize", (s) => normalize(s)));
```
- 언제: 모듈 최상위 함수, 콜백, 화살표 함수, 이벤트 핸들러.

### C. 특정 구간만:  measureBlock(name, ()=> work)
```ts
const result = await measureBlock("merge.step#1", () => doMergeStep());
```

### D. 한 번에 전체 메서드:  measureAllMethods(obj, prefix?)
```ts
const svc = measureAllMethods(new MergeService(), "MergeService");
```

### E. :  웹뷰(UI) : createUiMeasure (vscode)
```ts
const measureUi = createUiMeasure(vscode);
btn.onclick = () => measureUi("ui.exportJson", () => vscode.postMessage({ v:1, type:"perf.exportJson" }));
```


