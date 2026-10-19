import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { runBoth, scenarios } from './demo';
import './styles.css';

// Run the opening scenario before the first render so the demo never paints empty.
void runBoth(scenarios[0]!.key).catch(() => undefined).then(initial => {
  createRoot(document.getElementById('root')!).render(<React.StrictMode><App initial={initial} /></React.StrictMode>);
});
