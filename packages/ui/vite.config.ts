// ── Vite config (consumed by Ladle) ────────────────────────────────────────
//
// Ladle reads vite.config.ts from cwd. This file's only job is to wire
// UnoCSS so component story classNames actually generate CSS during
// preview.
//
// `unocss/vite` reads uno.config.ts from the same directory automatically.

import { defineConfig } from 'vite';
import UnoCSS from 'unocss/vite';

export default defineConfig({
  plugins: [UnoCSS()],
});
