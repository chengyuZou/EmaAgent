import 'virtual:uno.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatWindow } from '../chat/ChatWindow.js';
import { ErrorBoundary } from '../lib/error-boundary.js';
import { TooltipProvider } from '@ema-agent/ui';

// ── Chat sub-window entry ───────────────────────────────────────────────────

const container = document.getElementById('root');
if (!container) throw new Error('root element missing in chat.html');

// 顶层 boundary 兜面板自身 render 与 Provider 的错误; ChatWindow 内层 boundary
// 只管其子树, 两层是有意嵌套, 不要合并。
createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary>
      <TooltipProvider delayDuration={300}>
        <ChatWindow />
      </TooltipProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
