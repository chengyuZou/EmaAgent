import 'virtual:uno.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '@ema-agent/ui';
import { App } from './App.js';

const container = document.getElementById('root');
if (!container) throw new Error('root element missing in index.html');

createRoot(container).render(
  <React.StrictMode>
    <TooltipProvider delayDuration={300}>
      <App />
    </TooltipProvider>
  </React.StrictMode>,
);
