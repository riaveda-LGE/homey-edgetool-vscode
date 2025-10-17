// jest.setup.ts
import { jest } from '@jest/globals';

// Mock vscode module globally
jest.mock('vscode', () => ({
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
  commands: {
    executeCommand: jest.fn(),
  },
  ViewColumn: {
    Beside: 'Beside',
  },
  Uri: {
    joinPath: jest.fn(),
    file: jest.fn(),
  },
  workspace: {
    getConfiguration: jest.fn(() => ({
      get: jest.fn(),
      update: jest.fn(),
    })),
  },
}), { virtual: true });
