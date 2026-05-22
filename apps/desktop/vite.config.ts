import { defineConfig } from 'vite';
import react           from '@vitejs/plugin-react';

// Tauri 2 conventions:
//   - dev server on port 1420
//   - HMR via WebSocket on 1421
//   - public/ contents are served at /
// Tauri's main.rs will navigate the webview to http://localhost:1420 in dev.

export default defineConfig({
  plugins: [react()],
  // Prevent vite from clobbering Rust errors with the spinner UI.
  clearScreen: false,
  server: {
    port:        1420,
    strictPort:  true,
    host:        '127.0.0.1',
    hmr:         { protocol: 'ws', host: '127.0.0.1', port: 1421 },
    // Tauri expects assets relative to the root. publicDir defaults to "public".
  },
  // Build output (used by Tauri prod bundle later).
  build: {
    target:       ['es2022', 'chrome105', 'safari13'],
    minify:       'esbuild',
    sourcemap:    true,
    outDir:       'dist',
    emptyOutDir:  true,
  },
});
