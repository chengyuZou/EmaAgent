// ── Ladle global wrapper ────────────────────────────────────────────────────
//
// Auto-imported by Ladle for every story. We use it to:
//   1. Load UnoCSS virtual stylesheet so classNames in stories render styled
//   2. Apply a dark base background (matches the actual app's main window)

import 'virtual:uno.css';
import type { GlobalProvider } from '@ladle/react';

export const Provider: GlobalProvider = ({ children }) => (
  <div className="min-h-screen bg-neutral-950 text-white">{children}</div>
);
