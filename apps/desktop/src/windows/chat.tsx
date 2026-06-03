import 'virtual:uno.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatPanel } from '@ema-agent/desktop-ui';
import { DecisionLayer } from '@ema-agent/desktop-ui';

// ── Chat sub-window entry ───────────────────────────────────────────────────

const container = document.getElementById('root');
if (!container) throw new Error('root element missing in chat.html');

createRoot(container).render(
  <React.StrictMode>
    <ChatPanel />
    <DecisionLayer />
  </React.StrictMode>,
);
