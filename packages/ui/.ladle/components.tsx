// 让所有 Ladle stories 使用产品实际加载的主题变量、基础样式和动画。
//
// Auto-imported by Ladle for every story. We use it to:
//   1. Load UnoCSS virtual stylesheet so classNames in stories render styled
//   2. Apply a dark base background (matches the actual app's main window)

import 'virtual:uno.css';
import '../../../apps/desktop-ui/src/styles/index.css';
import type { GlobalProvider } from '@ladle/react';

export const Provider: GlobalProvider = ({ children }) => (
  <div className="min-h-screen bg-[var(--ema-bg)] text-[var(--ema-text-primary)]">{children}</div>
);
