// === src/extension/commands/edgepanel.buttons.ts ===
// Control 패널 버튼 "정의서(SSOT)" + DTO 변환 + 헬퍼

export type ButtonContext = {
  updateAvailable?: boolean;
  updateUrl?: string;
};

export type ButtonOp =
  | { kind: 'line'; line: string }              // 콘솔 라인
  | { kind: 'vscode'; command: string; args?: any[] } // VS Code 명령
  | { kind: 'post'; event: string; payload?: any }    // Webview 신호
  | { kind: 'handler'; name: string };          // 내부 핸들러

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
  items: { id: string; label: string; desc?: string }[];
};

// === 컨텍스트/DTO 유틸 ===
export function buildButtonContext(opts: {
  updateAvailable?: boolean;
  updateUrl?: string;
}): ButtonContext {
  return { updateAvailable: !!opts.updateAvailable, updateUrl: opts.updateUrl };
}

export function toSectionDTO(sections: SectionDef[], ctx: ButtonContext): SectionDTO[] {
  return sections
    .map((sec) => ({
      title: sec.title,
      items: sec.items
        .filter((b) => !b.when || b.when(ctx))
        .map((b) => ({ id: b.id, label: b.label, desc: b.desc })),
    }))
    .filter((sec) => sec.items.length > 0);
}

export function findButtonById(sections: SectionDef[], id: string): ButtonDef | undefined {
  for (const s of sections) {
    const f = s.items.find((b) => b.id === id);
    if (f) return f;
  }
  return undefined;
}

// === 버튼/섹션 정의서(SSOT) ===
export function getSections(): SectionDef[] {
  return [
    // panel 조작
    {
      id: 'panel',
      title: 'panel 조작',
      items: [
        { id: 'panel.toggleExplorer', label: '탐색창',   op: { kind: 'post', event: 'ui.toggleExplorer' } },
        { id: 'panel.toggleLogs',     label: '로그창',   op: { kind: 'post', event: 'ui.toggleLogs' } },
        {
          id: 'panel.updateNow',
          label: 'Update Now',
          desc: '확장 업데이트 확인/설치',
          op: { kind: 'handler', name: 'updateNow' },
          when: (ctx) => !!ctx.updateAvailable && !!ctx.updateUrl,
        },
        { id: 'panel.reload', label: 'VS Code 재시작', desc: 'VS Code 창 새로고침',
          op: { kind: 'vscode', command: 'workbench.action.reloadWindow' } },
      ],
    },

    // homey
    {
      id: 'homey',
      title: 'homey 조작',
      items: [
        { id: 'cmd.homeyLogging', label: '로그 보기',   op: { kind: 'line', line: 'homey-logging' } },
        { id: 'cmd.homeyRestart', label: '재시작',       op: { kind: 'line', line: 'homey-restart' } },
        { id: 'cmd.homeyMount',   label: '볼륨 마운트',  op: { kind: 'line', line: 'homey-mount' } },
        { id: 'cmd.homeyUnmount', label: '볼륨 언마운트', op: { kind: 'line', line: 'homey-unmount' } },
      ],
    },

    // workspace
    {
      id: 'workspace',
      title: '작업폴더',
      items: [
        { id: 'cmd.changeWorkspace', label: '작업폴더 변경', desc: '작업폴더 베이스 폴더 변경',
          op: { kind: 'handler', name: 'changeWorkspaceQuick' } },
        { id: 'cmd.openWorkspace',   label: '작업폴더 열기', desc: '현재 작업폴더 폴더 열기',
          op: { kind: 'handler', name: 'openWorkspace' } },
        { id: 'cmd.gitPull',         label: 'git pull', op: { kind: 'line', line: 'git pull' } },
        { id: 'cmd.gitPush',         label: 'git push', op: { kind: 'line', line: 'git push' } },
      ],
    },

    // help
    {
      id: 'help',
      title: '기타',
      items: [{ id: 'cmd.help', label: '도움말', op: { kind: 'handler', name: 'openHelp' } }],
    },
  ];
}
