// src/webviewers/log-viewer/views/dom.ts
export const el = {
  toolbar: document.getElementById('toolbar') as HTMLElement,
  topSplitter: document.getElementById('topSplitter') as HTMLElement,
  main: document.getElementById('main') as HTMLElement,
  center: document.getElementById('centerPane') as HTMLElement,
  logHeader: document.getElementById('logHeader') as HTMLElement,
  logGrid: document.getElementById('logGrid') as HTMLElement,
  bookmarkPane: document.getElementById('bookmarkPane') as HTMLElement,
  bmList: document.getElementById('bookmarkList') as HTMLElement,
  midSplitter: document.getElementById('midSplitter') as HTMLElement,
  bottomSplitter: document.getElementById('bottomSplitter') as HTMLElement,
  searchResults: document.getElementById('searchResults') as HTMLElement,
  msgModal: document.getElementById('msgModal') as HTMLElement,
  msgCloseBtn: document.getElementById('msgCloseBtn') as HTMLButtonElement,
  msgCopyBtn: document.getElementById('msgCopyBtn') as HTMLButtonElement,
  msgBody: document.getElementById('msgModalBody') as HTMLElement,
};

/* element helpers */
export function btn(label:string, onClick:()=>void, cls?:string){
  const b = document.createElement('button'); b.className = `btn ${cls||''}`; b.textContent = label; b.onclick = onClick; return b;
}
export function inputText(val:string, onInput:(v:string)=>void, ph?:string){
  const i = document.createElement('input'); i.type='text'; i.placeholder=ph||''; i.value = val;
  i.addEventListener('input', ()=>onInput(i.value));
  return i;
}
export function labelChk(label:string, checked:boolean, onChange:(on:boolean)=>void){
  const w = document.createElement('label'); w.style.display='inline-flex'; w.style.alignItems='center'; w.style.gap='6px';
  const c = document.createElement('input'); c.type='checkbox'; c.checked = checked;
  c.onchange = ()=>onChange(c.checked);
  w.append(c, document.createTextNode(label));
  return w;
}
export function span(cls:string, textContent?:string){
  const s = document.createElement('span'); s.className = cls; if (textContent!=null) s.textContent = textContent; return s;
}
export function text(t:string){ return document.createTextNode(t); }
export function div(cls:string, kids:(Node|null|undefined)[] = [], attrs?:Record<string,string>){
  const d = document.createElement('div'); d.className = cls;
  if (attrs) for (const k in attrs) d.setAttribute(k, attrs[k]);
  for (const k of kids) if (k) d.append(k);
  return d;
}
