import React from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsPanel } from '@ema-agent/desktop-ui';
import { DecisionLayer } from '@ema-agent/desktop-ui';

// ── Settings sub-window entry ───────────────────────────────────────────────

const container = document.getElementById('root');
if (!container) throw new Error('root element missing in settings.html');

createRoot(container).render(
  <React.StrictMode>
    <SettingsPanel />
    <DecisionLayer />
  </React.StrictMode>,
);
