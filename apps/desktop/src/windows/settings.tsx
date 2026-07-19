import 'virtual:uno.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsPanel } from '@ema-agent/desktop-ui';
import { TooltipProvider } from '@ema-agent/ui';

// ── Settings sub-window entry ───────────────────────────────────────────────

const container = document.getElementById('root');
if (!container) throw new Error('root element missing in settings.html');

createRoot(container).render(
  <React.StrictMode>
    <TooltipProvider delayDuration={300}>
      <SettingsPanel />
    </TooltipProvider>
  </React.StrictMode>,
);
