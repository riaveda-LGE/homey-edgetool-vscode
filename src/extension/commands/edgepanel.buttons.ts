// === src/extension/commands/edgepanel.buttons.ts ===
import { measureBlock } from '../../core/logging/perf.js';
import { UI_STR, UI_DESC } from '../../shared/const.js';

export type ButtonContext = {
  updateAvailable?: boolean;
  updateUrl?: string;
  busyLock?: boolean;
  /** 현재 활성 연결(ADB/SSH)이 존재하는가 */
  isConnected?: boolean;
  /** 홈이 볼륨 마운트 상태 */
  mountState?: 'mounted' | 'unmounted' | 'unknown';
  /** App Log / DevToken 현재 상태 */
  appLogEnabled?: boolean;
  devTokenEnabled?: boolean;
};

export type ButtonOp =
  | { kind: 'vscode'; command: string; args?: any[] }
  | { kind: 'post'; event: string; payload?: any }
  | { kind: 'handler'; name: string };

export type ButtonDef = {
  id: string;
  label: string;
  desc?: string;
  op: ButtonOp;
  when?: (ctx: ButtonContext) => boolean;
};

export type SectionDef = { id: string; title: string; items: ButtonDef[] };
export type SectionDTO = {
  title: string;
  items: { id: string; label: string; desc?: string; disabled?: boolean }[]; // ← disabled 추가
};

export function buildButtonContext(opts: {
  updateAvailable?: boolean;
  updateUrl?: string;
  busyLock?: boolean;
  isConnected?: boolean;
  mountState?: 'mounted' | 'unmounted' | 'unknown';
  appLogEnabled?: boolean;
  devTokenEnabled?: boolean;
}): ButtonContext {
  return {
    updateAvailable: !!opts.updateAvailable,
    updateUrl: opts.updateUrl,
    busyLock: !!opts.busyLock,
    isConnected: !!opts.isConnected,
    mountState: opts.mountState ?? 'unknown',
    appLogEnabled: !!opts.appLogEnabled,
    devTokenEnabled: !!opts.devTokenEnabled,
  };
}

export function toSectionDTO(sections: SectionDef[], ctx: ButtonContext): SectionDTO[] {
  return measureBlock('edgepanel.toSectionDTO', () => {
    return sections
      .map((sec) => {
        const items = sec.items
          .filter((b) => !b.when || b.when(ctx))
          .map((b) => ({
            id: b.id,
            label: b.label,
            desc: b.desc,
            // disabled 규칙:
            // 1) busyLock 대상은 작업 중 비활성화
            // 2) 연결 없으면 Device 버튼 일괄 비활성화("기기 연결" 제외)
            // 3) 토글 버튼 상태별 비활성화 조건
            disabled: (() => {
              // busy/연결 우선
              if ((BUSY_LOCK_BUTTON_IDS as readonly string[]).includes(b.id) && !!ctx.busyLock) return true;
              if (!ctx.isConnected && (DEVICE_BUTTON_IDS as readonly string[]).includes(b.id)) return true;

              // 토글류는 추가 제약 없음(연결만 체크). 라벨은 아래에서 상태로 분기.
              return false;
            })(),
          }));
        return { title: sec.title, items };
      })
      .filter((sec) => sec.items.length > 0);
 });
}

export function findButtonById(sections: SectionDef[], id: string): ButtonDef | undefined {
  return measureBlock('edgepanel.findButtonById', () => {
    for (const s of sections) {
      const f = s.items.find((b) => b.id === id);
      if (f) return f;
    }
    return undefined;
  });
}

export function getSections(): SectionDef[] {
  return [
    {
      id: 'panel',
      title: UI_STR.SECTION_PANEL_TITLE,
      items: [
        { id: 'panel.toggleExplorer', label: UI_STR.BTN_PANEL_TOGGLE_EXPLORER, op: { kind: 'post', event: 'ui.toggleExplorer' } },
        { id: 'panel.toggleLogs', label: UI_STR.BTN_PANEL_TOGGLE_LOGS, op: { kind: 'post', event: 'ui.toggleLogs' } },
        {
          id: 'panel.updateNow',
          label: UI_STR.BTN_UPDATE_NOW,
          desc: UI_DESC.UPDATE_NOW,
          op: { kind: 'handler', name: 'updateNow' },
          when: (ctx) => !!ctx.updateAvailable && !!ctx.updateUrl,
        },
      ],
    },

    {
      id: 'device',
      title: UI_STR.SECTION_DEVICE_TITLE,
      items: [
        { id: 'cmd.connectDevice', label: UI_STR.BTN_CONNECT_DEVICE, op: { kind: 'handler', name: 'connectDevice' } },
        { id: 'cmd.openHostShell', label: UI_STR.BTN_OPEN_HOST_SHELL, desc: UI_DESC.OPEN_HOST_SHELL, op: { kind: 'handler', name: 'openHostShell' } },
        { id: 'cmd.gitFlow', label: UI_STR.BTN_GIT_FLOW, desc: UI_DESC.GIT_FLOW, op: { kind: 'handler', name: 'gitFlow' } },
        { id: 'cmd.homeyLoggingLive', label: UI_STR.BTN_LOGGING_LIVE, desc: UI_DESC.LOGGING_LIVE, op: { kind: 'handler', name: 'homeyLoggingLive' } },
        { id: 'cmd.homeyLoggingFile', label: UI_STR.BTN_LOGGING_FILE, desc: UI_DESC.LOGGING_FILE, op: { kind: 'handler', name: 'homeyLoggingFile' } },
        { id: 'cmd.homeyRestart', label: UI_STR.BTN_HOMEY_RESTART, op: { kind: 'handler', name: 'homeyRestart' } },
        // ⬇️ 토글류는 기본(초기) 라벨만 배치 — 실제 표시 라벨은 Router에서 상태로 결정
        { id: 'cmd.volumeToggle',  label: UI_STR.BTN_VOLUME_MOUNT, op: { kind: 'handler', name: 'homeyVolumeToggle' } },
        { id: 'cmd.appLogToggle',  label: UI_STR.BTN_APPLOG_ENABLE,  desc: UI_DESC.APPLOG,  op: { kind: 'handler', name: 'homeyAppLogToggle' } },
        { id: 'cmd.devTokenToggle',label: UI_STR.BTN_DEVTOKEN_ENABLE, desc: UI_DESC.DEVTOKEN, op: { kind: 'handler', name: 'homeyDevTokenToggle' } },
      ],
    },

    {
      id: 'workspace',
      title: UI_STR.SECTION_WORKSPACE_TITLE,
      items: [
        { id: 'cmd.changeWorkspace', label: UI_STR.BTN_WORKSPACE_CHANGE, desc: UI_DESC.WORKSPACE_CHANGE, op: { kind: 'handler', name: 'changeWorkspaceQuick' } },
        { id: 'cmd.openWorkspace', label: UI_STR.BTN_OPEN_WORKSPACE, desc: UI_DESC.OPEN_WORKSPACE, op: { kind: 'handler', name: 'openWorkspace' } },
        { id: 'cmd.openWorkspaceShell', label: UI_STR.BTN_OPEN_WORKSPACE_SHELL, desc: UI_DESC.OPEN_WORKSPACE_SHELL, op: { kind: 'handler', name: 'openWorkspaceShell' } },
        { id: 'cmd.initWorkspace', label: UI_STR.BTN_INIT_WORKSPACE, desc: UI_DESC.INIT_WORKSPACE, op: { kind: 'handler', name: 'initWorkspace' } },
      ],
    },

    {
      id: 'help',
      title: UI_STR.SECTION_HELP_TITLE,
      items: [
        { id: 'cmd.performanceMonitor', label: UI_STR.BTN_PERF_MONITOR, desc: 'Performance Monitor 토글', op: { kind: 'handler', name: 'togglePerformanceMonitoring' } },
        { id: 'panel.reload', label: UI_STR.BTN_RELOAD_VSCODE, desc: UI_DESC.RELOAD, op: { kind: 'vscode', command: 'workbench.action.reloadWindow' } },
        { id: 'cmd.help', label: UI_STR.BTN_HELP, op: { kind: 'handler', name: 'openHelp' } },
      ],
    },
  ];
}

// 바쁜 동안 잠글 대상(토글 3개) — 확장/웹뷰 양쪽 공통 관점에서 식별자만 사용
export const BUSY_LOCK_BUTTON_IDS = [
  'cmd.volumeToggle',
  'cmd.appLogToggle',
  'cmd.devTokenToggle',
] as const;
export type BusyLockButtonId = typeof BUSY_LOCK_BUTTON_IDS[number];


// 🔌 연결이 없을 때 비활성화할 Device 섹션 버튼(“기기 연결” 제외)
export const DEVICE_BUTTON_IDS = [
  'cmd.openHostShell',
  'cmd.gitFlow',
  'cmd.homeyLoggingLive',
  'cmd.homeyRestart',
  'cmd.volumeToggle',
  'cmd.appLogToggle',
  'cmd.devTokenToggle',
] as const;