// src/webviewers/log-viewer/app/index.ts
// src/webviewers/log-viewer/app/index.ts
// === src/webviewers/log-viewer/app/index.ts ===
import { createUiLog } from '../../shared/utils';
import { mountSplitters, render } from '../views/AppView';
import { el } from '../views/dom';
import { initModel } from './model';
import { parseLogLine } from './parse';
import type { Model, Msg } from './types';
import { update } from './update';

// VS Code Webview API
declare const acquireVsCodeApi: () => {
  postMessage: (m: any) => void;
  getState?: () => any;
  setState?: (s: any) => void;
};
const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
const uiLog = createUiLog(vscode, 'log-viewer');

// MVU 런타임 (아주 얇게)
let model: Model = initModel();

function dispatch(msg: Msg) {
  model = update(model, msg);
  render(model, dispatch);
}

// --- prefs: 초기 요청 ---
uiLog.debug('init: request user prefs');
vscode?.postMessage({ v: 1, type: 'logviewer.getUserPrefs', payload: {} });

// --- 호스트 → 웹뷰 메시지 수신 ---
window.addEventListener('message', (ev) => {
  const m = ev.data || {};
  if (!m || m.v !== 1) return;

  // 1) 사용자 설정 동기화
  if (m.type === 'logviewer.prefs') {
    uiLog.debug('prefs: received, applying toggles');
    const p = m.payload?.prefs ?? {};

    // 열 표시 상태 (ToggleColumn 재사용)
    if (typeof p.showTime === 'boolean') {
      dispatch({ type: 'ToggleColumn', col: 'time', on: !!p.showTime });
    }
    if (typeof p.showProc === 'boolean') {
      dispatch({ type: 'ToggleColumn', col: 'proc', on: !!p.showProc });
    }
    if (typeof p.showPid === 'boolean') {
      dispatch({ type: 'ToggleColumn', col: 'pid', on: !!p.showPid });
    }
    // 파일(src) 열
    if (typeof p.showSrc === 'boolean') {
      dispatch({ type: 'ToggleColumn', col: 'src', on: !!p.showSrc });
    }
    if (typeof p.showMsg === 'boolean') {
      dispatch({ type: 'ToggleColumn', col: 'msg', on: !!p.showMsg });
    }

    // 북마크 패널 상태 동기화
    if (typeof p.bookmarksOpen === 'boolean') {
      const want = !!p.bookmarksOpen;
      const cur = (model as any).showBookmarks === true;
      if (cur !== want) {
        dispatch({ type: 'ToggleBookmarksPane' });
      }
    }
    return;
  }

  // 2) 로그 배치 수신 (초기 스냅샷)
  if (m.type === 'logs.batch') {
    const logs = Array.isArray(m.payload?.logs) ? m.payload.logs : [];
    const total = typeof m.payload?.total === 'number' ? m.payload.total : undefined;
    const seq = typeof m.payload?.seq === 'number' ? m.payload.seq : undefined;
    uiLog.info(`merge: initial batch received len=${logs.length} total=${total ?? 'unknown'} seq=${seq ?? -1}`);

    // 진행률은 merge.progress에서만 갱신(중복 누적 방지)
    if (typeof total === 'number') {
      dispatch({ type: 'SetTotalRows', total });
    }

    // 초기 윈도우(최신부터 windowSize만큼)를 ReceiveRows로 교체
    let nextId = model.nextId;
    const rows = logs.map((e: any) => {
      const p = parseLogLine(String(e?.text ?? ''));
      return { id: nextId++, ...p, src: String(e?.source ?? '') };
    });
    dispatch({ type: 'ReceiveRows', startIdx: 1, rows });

    return;
  }

  // 3) 페이지 응답: 호스트의 온디맨드 페이지 로드 결과
  if (m.type === 'logs.page.response') {
    const startIdx = Number(m.payload?.startIdx) || 1;
    const endIdx = Number(m.payload?.endIdx) || startIdx;
    const items: any[] = Array.isArray(m.payload?.logs) ? m.payload.logs : [];
    let nextId = model.nextId;
    const rows = items.map((e: any) => {
      const p = parseLogLine(String(e?.text ?? ''));
      return { id: nextId++, ...p, src: String(e?.source ?? '') };
    });
    uiLog.debug(`page: response ${startIdx}-${endIdx} count=${rows.length}`);
    dispatch({ type: 'ReceiveRows', startIdx, rows });
    return;
  }

  // 4) 병합 진행률
  if (m.type === 'merge.progress') {
    const inc = typeof m?.payload?.inc === 'number' ? m.payload.inc : undefined;
    const total = typeof m?.payload?.total === 'number' ? m.payload.total : undefined;
    const active = typeof m?.payload?.active === 'boolean' ? m.payload.active : undefined;
    uiLog.debug(`progress: inc=${inc ?? 0} total=${total ?? ''} active=${String(active)}`);
    dispatch({ type: 'MergeProgress', inc, total, active });
    return;
  }

  // 5) 저장 완료(프로그레스 100%로 고정)
  if (m.type === 'logmerge.saved') {
    const total: number | undefined =
      (typeof m.payload?.total === 'number' ? m.payload.total : undefined) ??
      (typeof m.payload?.merged === 'number' ? m.payload.merged : undefined);

    if (typeof total === 'number') {
      // 남은 갭만큼 증분하여 (total/total)로 맞추고 active=false
      const need = Math.max(0, total - (model as any).mergeDone);
      dispatch({ type: 'MergeProgress', inc: need, total, active: false });
      dispatch({ type: 'SetTotalRows', total });
    } else {
      // total을 모르면 active만 false로
      dispatch({ type: 'MergeProgress', inc: 0, total: undefined, active: false });
    }
    return;
  }

  // 6) 오류 이벤트(호스트에서 온 것)
  if (m.type === 'error') {
    const code = String(m?.payload?.code ?? '');
    const message = String(m?.payload?.message ?? '');
    uiLog.error(`host-error: ${code} ${message}`);
    return;
  }
});

// --- 툴바 DOM → 저장 호출 (기존 메시지 유지) ---
function bindToolbarSaveHooks() {
  const byId = <T extends HTMLElement>(id: string) =>
    document.getElementById(id) as T | null;
  const chkTime = byId<HTMLInputElement>('chkTime');
  const chkProc = byId<HTMLInputElement>('chkProc');
  const chkPid  = byId<HTMLInputElement>('chkPid');
  const chkSrc  = byId<HTMLInputElement>('chkSrc'); // ← 파일(src) 체크박스
  const chkMsg  = byId<HTMLInputElement>('chkMsg');
  const btnToggleBookmarks = byId<HTMLButtonElement>('btnToggleBookmarks');

  chkTime?.addEventListener('change', () => {
    vscode?.postMessage({ v: 1, type: 'logviewer.saveUserPrefs', payload: { prefs: { showTime: !!chkTime.checked } } });
  });
  chkProc?.addEventListener('change', () => {
    vscode?.postMessage({ v: 1, type: 'logviewer.saveUserPrefs', payload: { prefs: { showProc: !!chkProc.checked } } });
  });
  chkPid?.addEventListener('change', () => {
    vscode?.postMessage({ v: 1, type: 'logviewer.saveUserPrefs', payload: { prefs: { showPid: !!chkPid.checked } } });
  });
  chkSrc?.addEventListener('change', () => {
    vscode?.postMessage({ v: 1, type: 'logviewer.saveUserPrefs', payload: { prefs: { showSrc: !!chkSrc.checked } } });
  });
  chkMsg?.addEventListener('change', () => {
    vscode?.postMessage({ v: 1, type: 'logviewer.saveUserPrefs', payload: { prefs: { showMsg: !!chkMsg.checked } } });
  });
  btnToggleBookmarks?.addEventListener('click', () => {
    const next = !(model as any).showBookmarks;
    vscode?.postMessage({ v: 1, type: 'logviewer.saveUserPrefs', payload: { prefs: { bookmarksOpen: next } } });
  });
}

// 초기 mount
mountSplitters(dispatch);
render(model, dispatch);
bindToolbarSaveHooks();

// ─────────────────────────────────────────────────────────
// 스크롤 → 윈도우 계산 → 페이지 요청
// ─────────────────────────────────────────────────────────
let _scrollBind = false;
function bindVirtualScroll() {
  if (_scrollBind || !el.logGrid) return;
  _scrollBind = true;
  el.logGrid.addEventListener('scroll', () => {
    // 가시 범위의 시작 전역 인덱스 추정(최신=1, 위에서 아래로 커짐)
    const estStart = Math.floor(el.logGrid.scrollTop / model.rowH) + 1;
    const desiredStart =
      clamp(estStart - Math.floor(model.overscan / 2), 1, Math.max(1, model.totalRows - model.windowSize + 1));

    // 너무 자주 요청하지 않도록 이동 임계값
    const delta = Math.abs(desiredStart - model.windowStart);
    if (delta < Math.max(10, Math.floor(model.overscan / 2))) return;

    const startIdx = desiredStart;
    const endIdx = Math.min(model.totalRows, startIdx + model.windowSize - 1);
    uiLog.debug(`page: request ${startIdx}-${endIdx} (estStart=${estStart})`);
    vscode?.postMessage({ v: 1, type: 'logs.page.request', payload: { startIdx, endIdx }});
  }, { passive: true });
}

function clamp(n: number, a: number, b: number) {
  return Math.min(b, Math.max(a, n));
}

bindVirtualScroll();
