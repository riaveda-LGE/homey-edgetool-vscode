import '../styles/tailwind.css';
import '../styles/tokens.css';

import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './components/App';
import { setupIpc } from './ipc';

const el = document.getElementById('app')!;
const root = createRoot(el);

function Boot() {
  useEffect(() => {
    setupIpc();
  }, []);
  return <App />;
}

root.render(<Boot />);
