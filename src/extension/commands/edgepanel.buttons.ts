// === src/extension/commands/edgepanel.buttons.ts ===
// Control 패널 버튼 "정의서(SSOT)" + DTO 변환 + 헬퍼
// - 버튼 추가/수정/숨김은 이 파일만 손보면 됨
// - 실행 로직은 Host(Extension) 쪽 공용 디스패처가 처리

export type ButtonContext = {
  updateAvailable?: boolean;
  updateUrl?: string;
};

export type ButtonOp =
  | { kind: 'line'; line: string }                    // 콘솔 라인 그대로 실행 → commandHandlers.route()
  | { kind: 'vscode'; command: string; args?: any[] } // VS Code 명령 실행
  | { kind: 'post'; event: string; payload?: any }    // Webview로 신호만 보냄(예: ui.toggleMode)
  | { kind: 'handler'; name: string };                // 특수 처리(Host 내부 전용 핸들러)

export type ButtonDef = {
  id: string;           // 전역 유니크. '도메인.의도' 권장(ex: panel.updateNow, cmd.homeyLogging)
  label: string;        // 버튼 라벨
  desc?: string;        // 툴팁(선택)
  op: ButtonOp;         // 실행 타입
  when?: (ctx: ButtonContext) => boolean; // 표시 조건(선택)
};

export type SectionDef = {
  id: string;
  title: string;        // 카드 제목
  items: ButtonDef[];
};

export type SectionDTO = {
  title: string;
  items: { id: string; label: string; desc?: string }[];
};

// === 컨텍스트/DTO 유틸 ===
export function buildButtonContext(opts: {
  updateAvailable?: boolean;
  updateUrl?: string;
}): ButtonContext {
  return {
    updateAvailable: !!opts.updateAvailable,
    updateUrl: opts.updateUrl,
  };
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

// === 버튼/섹션 "정의서" ===
export function getSections(): SectionDef[] {
  return [
    // ✅ 새 섹션: panel 조작 (상단 고정 버튼을 섹션으로 이동)
    {
      id: 'panel',
      title: 'panel 조작',
      items: [
        {
          id: 'panel.toggleMode',
          label: 'Panel Mode',
          desc: '패널 모드 토글',
          op: { kind: 'post', event: 'ui.toggleMode' }, // Webview가 수신해서 모드 전환
        },
        {
          id: 'panel.updateNow',
          label: 'Update Now',
          desc: '확장 업데이트 확인/설치',
          op: { kind: 'handler', name: 'updateNow' },   // Host에서 _handleUpdateNow 실행
          when: (ctx) => !!ctx.updateAvailable && !!ctx.updateUrl, // 가능할 때만 표시
        },
        {
          id: 'panel.reload',
          label: 'Reload',
          desc: 'VS Code 창 새로고침',
          op: { kind: 'vscode', command: 'workbench.action.reloadWindow' },
        },
      ],
    },

    // 기존 섹션들
    {
      id: 'homey',
      title: 'homey 조작',
      items: [
        { id: 'cmd.homeyLogging',       label: 'homey-logging',       op: { kind: 'line', line: 'homey-logging' } },
        { id: 'cmd.homeyLoggingDir',    label: 'homey-logging (dir)', desc: '폴더 선택 후 병합', op: { kind: 'line', line: 'homey-logging --dir ' } },
        { id: 'cmd.homeyRestart',       label: 'homey-restart',       op: { kind: 'line', line: 'homey-restart' } },
        { id: 'cmd.homeyMount',         label: 'homey-mount',         op: { kind: 'line', line: 'homey-mount' } },
        { id: 'cmd.homeyUnmount',       label: 'homey-unmount',       op: { kind: 'line', line: 'homey-unmount' } },
      ],
    },
    {
      id: 'host',
      title: 'host 조작',
      items: [
        { id: 'cmd.host',   label: 'host …',  desc: '원격 호스트 명령', op: { kind: 'line', line: 'host ' } },
        { id: 'cmd.shell',  label: 'shell',   op: { kind: 'line', line: 'shell' } },
      ],
    },
    {
      id: 'git',
      title: 'Git',
      items: [
        { id: 'cmd.gitPull', label: 'git pull', op: { kind: 'line', line: 'git pull' } },
        { id: 'cmd.gitPush', label: 'git push', op: { kind: 'line', line: 'git push' } },
      ],
    },
    {
      id: 'help',
      title: '도움말',
      items: [
        { id: 'cmd.help', label: 'help', op: { kind: 'line', line: 'help' } },
      ],
    },
  ];
}
