/// <reference types="jest" />

// ── vscode 모듈 전역 mock ─────────────────────────────────────────────
jest.mock(
  'vscode',
  () => ({
    window: {
      createOutputChannel: jest.fn(() => ({
        appendLine: jest.fn(),
        show: jest.fn(),
      })),
      createWebviewPanel: jest.fn(),
      showOpenDialog: jest.fn(),
      showInputBox: jest.fn(),
      showQuickPick: jest.fn(),
      showInformationMessage: jest.fn(),
      showErrorMessage: jest.fn(),
    },
    commands: { executeCommand: jest.fn() },
    ViewColumn: { Beside: 'Beside' },
    Uri: { joinPath: jest.fn(), file: jest.fn() },
    workspace: {
      getConfiguration: jest.fn(() => ({ get: jest.fn(), update: jest.fn() })),
    },
  }),
  { virtual: true }
);

// ── 테스트 중에만 console.* 활성화 + CustomConsole 우회 ───────────────
// (teardown 이후 늦게 오는 로그는 무시. 허용 시에도 process.stdout/stderr로 직접 출력)
const writeStdout = (...args: any[]) => {
  try {
    const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    // 줄바꿈 보장
    (process.stdout as any).write(msg + '\n');
  } catch { /* noop */ }
};
const writeStderr = (...args: any[]) => {
  try {
    const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    (process.stderr as any).write(msg + '\n');
  } catch { /* noop */ }
};

function guarded<T extends (...a: any[]) => any>(fn: T): T {
  const wrapper = ((...args: any[]) => {
    if ((globalThis as any).__JEST_TEST_ACTIVE__) {
      return fn(...args); // 테스트 진행 중일 때만 허용
    }
    // 테스트 컨텍스트 밖(tear-down 포함)에서는 드랍
    return;
  }) as T;
  return wrapper;
}

// 원본 대신 직접 writer 사용(= Jest CustomConsole를 거치지 않음)
console.log   = guarded(writeStdout as any) as any;
console.info  = guarded(writeStdout as any) as any;
console.warn  = guarded(writeStderr as any) as any;
console.error = guarded(writeStderr as any) as any;
if ((console as any).debug) (console as any).debug = guarded(writeStdout as any);

// 각 테스트 생명주기에 맞춰 on/off
beforeAll(() => { (globalThis as any).__JEST_TEST_ACTIVE__ = true; });
afterEach(() => { (globalThis as any).__JEST_TEST_ACTIVE__ = false; });
beforeEach(() => { (globalThis as any).__JEST_TEST_ACTIVE__ = true; });
afterAll(() =>  { (globalThis as any).__JEST_TEST_ACTIVE__ = false; });
