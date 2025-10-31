// === src/extension/panels/EdgePanelActionRouter.ts ===
import * as vscode from 'vscode';

import { getLogger } from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';
import { connectionManager } from '../../core/connection/ConnectionManager.js';
import { createCommandHandlers } from '../commands/commandHandlers.js';
import {
  buildButtonContext,
  type ButtonDef,
  findButtonById,
  getSections,
  toSectionDTO,
  BUSY_LOCK_BUTTON_IDS,
} from '../commands/edgepanel.buttons.js';
import type { PerfMonitor } from '../editors/PerfMonitorEditorProvider.js';
import type { ExplorerBridge } from './explorerBridge.js';
import type { EdgePanelProvider } from './extensionPanel.js';
import { getMountState, getEnvToggleEnabled } from '../../core/state/DeviceState.js';
import { UI_STR } from '../../shared/const.js';

const log = getLogger('EdgePanelActionRouter');

export interface IEdgePanelActionRouter {
  sendButtonSections(): void;
  dispatchButton(id: string): Promise<void>;
  dispose(): void;
}

export class EdgePanelActionRouter implements IEdgePanelActionRouter {
  private _buttonSections = getSections();
  private _handlers?: ReturnType<typeof createCommandHandlers>;
  private _busyLock = false; // 🔒 동작 중 잠금 상태

  constructor(
    private _view: vscode.WebviewView,
    private _context: vscode.ExtensionContext,
    private _extensionUri: vscode.Uri,
    private _updateState: { updateAvailable: boolean; updateUrl?: string; latestSha?: string },
    private _provider: EdgePanelProvider,
    private _perfMonitor?: PerfMonitor,
    private _explorer?: ExplorerBridge,
  ) {
    // 핸들러는 필요 시 지연 생성
  }

  // busy 잠금/해제: 표준 이벤트로 통일(+재렌더)
  private _setBusyLock(on: boolean) {
    if (this._busyLock === on) return;
    this._busyLock = on;
    // 재렌더 시 disabled 값 반영
    this.sendButtonSections().catch(() => {});
    // 웹뷰는 buttons.lock/unlock 을 수신하여 실제 DOM disabled 처리
    this._view.webview.postMessage({
      v: 1,
      type: on ? 'buttons.lock' : 'buttons.unlock',
      payload: { ids: Array.from(BUSY_LOCK_BUTTON_IDS) },
    });
  }

  @measure()
  async sendButtonSections() {
    // 최신 연결/마운트 상태를 함께 조회
    const isConnected = connectionManager.isConnected();
    const mountState = await getMountState(
      (vscode as any).extensions?.extensionContext as vscode.ExtensionContext | undefined,
    ).catch(() => 'unknown' as const);

    // App Log / DevToken 상태 조회(연결 없으면 기본 false)
    const [appLogEnabled, devTokenEnabled] = isConnected
      ? await Promise.all([
          getEnvToggleEnabled('HOMEY_APP_LOG').catch(() => false),
          getEnvToggleEnabled('HOMEY_DEV_TOKEN').catch(() => false),
        ])
      : [false, false];
    const ctx = buildButtonContext({
      updateAvailable: this._updateState.updateAvailable,
      updateUrl: this._updateState.updateUrl,
      busyLock: this._busyLock,
      isConnected,
      mountState,
      appLogEnabled,
      devTokenEnabled,
    });

    // 동적 라벨 반영: 상태 기반으로 섹션 사본을 만들어 라벨만 교체
    const dynamic = this._buttonSections.map((sec) => ({
      ...sec,
      items: sec.items.map((b) => {
        if (b.id === 'cmd.volumeToggle') {
          const label = mountState === 'mounted' ? UI_STR.BTN_VOLUME_UNMOUNT : UI_STR.BTN_VOLUME_MOUNT;
          return { ...b, label };
        }
        if (b.id === 'cmd.appLogToggle') {
          const label = ctx.appLogEnabled ? UI_STR.BTN_APPLOG_DISABLE : UI_STR.BTN_APPLOG_ENABLE;
          return { ...b, label };
        }
        if (b.id === 'cmd.devTokenToggle') {
          const label = ctx.devTokenEnabled ? UI_STR.BTN_DEVTOKEN_DISABLE : UI_STR.BTN_DEVTOKEN_ENABLE;
          return { ...b, label };
        }
        return b;
      }),
    }));

    const dto = toSectionDTO(dynamic, ctx);
    this._view.webview.postMessage({ v: 1, type: 'buttons.set', payload: { sections: dto } });
  }

  @measure()
  async dispatchButton(id: string) {
    const btn = findButtonById(this._buttonSections, id);
     if (!btn) return;
    // 바쁜 동안에는 잠금 대상 버튼 클릭 무시
    const isLockTarget = (BUSY_LOCK_BUTTON_IDS as readonly string[]).includes(id);
    if (isLockTarget && this._busyLock) {
      log.warn(`busy: drop click ${id}`);
      return;
    }
    if (!this._handlers) {
      this._handlers = createCommandHandlers(this._context, this._extensionUri, this._provider);
    }

    const invoke = async () => {
      const op = btn.op;
      if (op.kind === 'handler') {
        await this._handlers!.route(op.name);       // ← 반드시 await
      } else if (op.kind === 'vscode') {
        await vscode.commands.executeCommand(op.command, ...(op.args ?? []));
      } else if (op.kind === 'post') {
        this._view.webview.postMessage({ type: op.event, payload: op.payload ?? null });
      }
    };

    try {
      if (isLockTarget) this._setBusyLock(true);
      await invoke();
    } catch (e) {
      log.error(`dispatch failed for ${id}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (isLockTarget) this._setBusyLock(false);
      // ✅ 명령 수행 후 버튼 상태 재계산(연결 상태 변화 반영)
      this.sendButtonSections().catch(() => {});
    }
  }

  @measure()
  dispose() {
    log.debug('[debug] EdgePanelActionRouter dispose: start');
    this._handlers = undefined;
    log.debug('[debug] EdgePanelActionRouter dispose: end');
  }
}
