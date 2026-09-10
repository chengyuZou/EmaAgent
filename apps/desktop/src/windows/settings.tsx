import 'virtual:uno.css';
import '../styles/index.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsPanel } from '../settings/SettingsPanel.js';
import { ErrorBoundary } from '../lib/error-boundary.js';
import { TooltipProvider } from '@ema-agent/ui';

// ── Settings sub-window entry ───────────────────────────────────────────────

declare global {
  interface Window {
    __emaOriginalCanvasGetContext?: HTMLCanvasElement['getContext'];
    __emaWebGlContextCount?: number;
  }
}

function installWebGlContextProbe(): void {
  if (window.__emaOriginalCanvasGetContext) return;

  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const observed = new WeakMap<HTMLCanvasElement, Set<string>>();

  window.__emaOriginalCanvasGetContext = originalGetContext;
  window.__emaWebGlContextCount = 0;

  HTMLCanvasElement.prototype.getContext = function getContextWithProbe(
    this: HTMLCanvasElement,
    contextId: string,
    options?: unknown,
  ) {
    const context = Reflect.apply(originalGetContext, this, [contextId, options]);
    if (!context || (contextId !== 'webgl' && contextId !== 'webgl2' && contextId !== 'experimental-webgl')) {
      return context;
    }

    let canvasContexts = observed.get(this);
    if (!canvasContexts) {
      canvasContexts = new Set<string>();
      observed.set(this, canvasContexts);
    }
    if (canvasContexts.has(contextId)) return context;
    canvasContexts.add(contextId);

    const count = (window.__emaWebGlContextCount ?? 0) + 1;
    window.__emaWebGlContextCount = count;
    if (count <= 8 || count % 100 === 0) {
      console.warn('[DEBUG-webgl-context] created', {
        count,
        contextId,
        canvasConnected: this.isConnected,
        canvasSize: `${this.width}x${this.height}`,
        stack: new Error().stack,
      });
    }

    return context;
  } as HTMLCanvasElement['getContext'];
}

installWebGlContextProbe();

const container = document.getElementById('root');
if (!container) throw new Error('root element missing in settings.html');

// 顶层 boundary 兜面板自身 render 与 Provider 的错误; SettingsPanel 内层
// boundary 只管其子树, 两层是有意嵌套, 不要合并。
createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary>
      <TooltipProvider delayDuration={300}>
        <SettingsPanel />
      </TooltipProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
