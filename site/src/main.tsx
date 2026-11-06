import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { runBoth, scenarios } from './demo';
// self-hosted so visitors' browsers never contact google fonts
import '@fontsource-variable/archivo/standard.css';
import '@fontsource-variable/martian-mono/wght.css';
import './styles.css';

// Run the opening scenario before the first render so the demo never paints empty.
void runBoth(scenarios[0]!.key).catch(() => undefined).then(initial => {
  createRoot(document.getElementById('root')!).render(<React.StrictMode><App initial={initial} /></React.StrictMode>);
});
