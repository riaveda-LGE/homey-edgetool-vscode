import { createRoot } from 'react-dom/client';
import { useEffect } from 'react';
import { App } from './components/App';
import { setupIpc } from './ipc';
import '../styles/tailwind.css';
import '../styles/tokens.css';

const el = document.getElementById('app')!;
const root = createRoot(el);

function Boot(){
  useEffect(()=>{ setupIpc(); }, []);
  return <App />;
}

root.render(<Boot />);
