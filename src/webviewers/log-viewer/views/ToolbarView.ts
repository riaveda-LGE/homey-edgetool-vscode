// src/webviewers/log-viewer/views/ToolbarView.ts
import type { HighlightRule,Model, Msg } from '../app/types';
import { el } from './dom';

let bound = false;

export function renderToolbar(m: Model, dispatch:(msg:Msg)=>void){
  if (!bound) {
    bound = true;
    bindStaticToolbar(dispatch);
  }

  const chkTime = document.getElementById('chkTime') as HTMLInputElement | null;
  const chkProc = document.getElementById('chkProc') as HTMLInputElement | null;
  const chkPid  = document.getElementById('chkPid')  as HTMLInputElement | null;
  const chkSrc  = document.getElementById('chkSrc')  as HTMLInputElement | null;
  const chkMsg  = document.getElementById('chkMsg')  as HTMLInputElement | null;

  if (chkTime) chkTime.checked = m.showCols.time;
  if (chkProc) chkProc.checked = m.showCols.proc;
  if (chkPid)  chkPid.checked  = m.showCols.pid;
  if (chkSrc)  chkSrc.checked  = m.showCols.src;
  if (chkMsg)  chkMsg.checked  = m.showCols.msg;

  // 검색 인풋 값 동기화
  const searchInput = document.getElementById('searchInput') as HTMLInputElement | null;
  if (searchInput && searchInput.value !== m.searchQuery) {
    searchInput.value = m.searchQuery;
  }

  // 병합 진행률 UI 동기화
  syncMergeProgress(m);

  // 하이라이트 팝오버 필드 동기화
  syncHighlightPopover(m);
}

function bindStaticToolbar(dispatch:(msg:Msg)=>void){
  const btnHL       = document.getElementById('btnHighlight')   as HTMLButtonElement | null;
  const hlPop       = document.getElementById('hlPop')           as HTMLDivElement   | null;
  const btnHLApply  = document.getElementById('hlApply')         as HTMLButtonElement | null;
  const btnHLCancel = document.getElementById('hlCancel')        as HTMLButtonElement | null;

  btnHL?.addEventListener('click', ()=>{ if (hlPop) hlPop.hidden = !hlPop.hidden; });
  btnHLCancel?.addEventListener('click', ()=>{ if (hlPop) hlPop.hidden = true; });
  btnHLApply?.addEventListener('click', ()=>{
    if (!hlPop) return;
    const rules = readHighlightRulesFromPopover();
    dispatch({ type:'SetHighlights', rules });
    hlPop.hidden = true;
  });

  // 파일(src) 체크박스가 없으면 동적 삽입
  ensureSrcCheckbox(dispatch);

  // 컬럼 토글 바인딩
  const bind = (id:string, col: keyof Model['showCols']) => {
    (document.getElementById(id) as HTMLInputElement | null)
      ?.addEventListener('change', e => {
        const on = (e.target as HTMLInputElement).checked;
        dispatch({type:'ToggleColumn', col: col as any, on});
      });
  };
  bind('chkTime','time'); bind('chkProc','proc'); bind('chkPid','pid'); bind('chkSrc','src'); bind('chkMsg','msg');

  // 검색
  const searchInput = document.getElementById('searchInput') as HTMLInputElement | null;
  searchInput?.addEventListener('input', ()=>{
    dispatch({ type:'Search', q: searchInput.value });
  });
  document.getElementById('btnSearchClose')?.addEventListener('click', ()=> dispatch({ type:'SearchClose' }));
  document.getElementById('btnToggleBookmarks')?.addEventListener('click', ()=> dispatch({ type:'ToggleBookmarksPane' }));

  // 하이라이트 색 스와치 클릭 바인딩
  for (let i = 1; i <= 5; i++) {
    for (let c = 1; c <= 12; c++) {
      const id = `hl${i}-c${c}`;
      const sw = document.getElementById(id) as HTMLDivElement | null;
      if (sw) sw.addEventListener('click', () => setSelectedSwatch(i, c));
    }
  }
}

function ensureSrcCheckbox(dispatch:(msg:Msg)=>void){
  if (document.getElementById('chkSrc')) return;
  const msgInput = document.getElementById('chkMsg') as HTMLInputElement | null;
  const anchor = msgInput?.parentElement ?? document.querySelector('.lv-toolbar .group') ?? document.querySelector('.lv-toolbar');
  if (!anchor) return;

  const label = document.createElement('label');
  label.style.display = 'inline-flex';
  label.style.alignItems = 'center';
  label.style.gap = '6px';
  label.style.marginRight = '8px';
  label.innerHTML = `<input type="checkbox" id="chkSrc" /> 파일`;

  if (msgInput?.parentElement) msgInput.parentElement.insertAdjacentElement('beforebegin', label);
  else anchor.appendChild(label);

  const chk = label.querySelector('#chkSrc') as HTMLInputElement;
  chk.addEventListener('change', e => {
    const on = (e.target as HTMLInputElement).checked;
    dispatch({ type:'ToggleColumn', col:'src', on });
  });
}

function syncHighlightPopover(m: Model){
  for (let i=1; i<=5; i++){
    const textEl = document.getElementById(`hl${i}-text`) as HTMLInputElement | null;
    const rule = m.highlights[i-1];
    if (textEl) textEl.value = rule?.text ?? '';
    const colorCode = rule?.color ?? 'c1';
    const cNum = Number(colorCode.replace('c','')) || 1;
    setSelectedSwatch(i, cNum, false);
  }
}

function readHighlightRulesFromPopover(): HighlightRule[] {
  const rules: HighlightRule[] = [];
  for (let i=1; i<=5; i++){
    const textEl  = document.getElementById(`hl${i}-text`)   as HTMLInputElement | null;
    const colorEl = document.getElementById(`hl${i}-picked`) as HTMLInputElement | null;
    const text = (textEl?.value || '').trim();
    if (!text) continue;
    const color = (colorEl?.value || 'c1') as HighlightRule['color'];
    rules.push({ text, color });
  }
  return rules;
}

function setSelectedSwatch(slot:number, c:number, focusHiddenInput = true){
  for (let i=1; i<=12; i++){
    const sw = document.getElementById(`hl${slot}-c${i}`);
    sw?.classList.remove('sel');
  }
  document.getElementById(`hl${slot}-c${c}`)?.classList.add('sel');
  const picked = document.getElementById(`hl${slot}-picked`) as HTMLInputElement | null;
  if (picked){
    picked.value = `c${c}`;
    if (focusHiddenInput) picked.dispatchEvent(new Event('change'));
  }
}

function syncMergeProgress(m: Model){
  const wrap = document.getElementById('mergeProgress') as HTMLDivElement | null;
  const fill = document.getElementById('mergeProgressFill') as HTMLDivElement | null;
  const label = document.getElementById('mergeProgressLabel') as HTMLSpanElement | null;
  if (!wrap || !fill || !label) return;

  const total = m.mergeTotal;
  const done = m.mergeDone;
  const active = m.mergeActive;

  // total이 잡히면 항상 보이게, 없으면 숨김
  if (total > 0) {
    // 완료 시 바/라벨을 (total/total)로 고정
    const dispDone = (!active && done >= total) ? total : Math.min(done, total);
    const pct = Math.max(0, Math.min(100, Math.floor((dispDone / total) * 100)));

    fill.style.width = `${pct}%`;
    label.textContent = `(${dispDone}/${total})`;
    wrap.hidden = false;
  } else {
    fill.style.width = '0%';
    label.textContent = `(0/0)`;
    wrap.hidden = true;
  }
}
