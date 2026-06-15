import 'virtual:uno.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatPanel } from '@ema-agent/desktop-ui';
import { DecisionLayer } from '@ema-agent/desktop-ui';
import { TooltipProvider } from '@ema-agent/ui';

// ── Chat sub-window entry ───────────────────────────────────────────────────

const container = document.getElementById('root');
if (!container) throw new Error('root element missing in chat.html');

createRoot(container).render(
  <React.StrictMode>
    <TooltipProvider delayDuration={300}>
      <ChatPanel />
      <DecisionLayer />
    </TooltipProvider>
  </React.StrictMode>,
);
