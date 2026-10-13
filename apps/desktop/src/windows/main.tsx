import 'virtual:uno.css';
import '../styles/index.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MainWindow } from '../layout/main.js';
import { ErrorBoundary } from '../lib/errorBoundary.js';
import { TooltipProvider } from '@ema-agent/ui';

const container = document.getElementById('root');
if (!container) {
  throw new Error('root element missing in main.html');
}

// 外层捕获窗口和 Provider 错误, 各 View 自己保留业务内容的错误处理.
createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary>
      <TooltipProvider>
        <MainWindow />
      </TooltipProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
