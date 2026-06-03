import { defineConfig }               from 'vite';
import react                           from '@vitejs/plugin-react';
import UnoCSS                          from 'unocss/vite';
import { presetUno, presetAttributify } from 'unocss';
import { resolve }                     from 'node:path';

// Tauri 2 conventions:
//   - dev server on port 1420
//   - HMR via WebSocket on 1421
//   - public/ contents are served at /
// Tauri's main.rs will navigate the webview to http://localhost:1420 in dev.

export default defineConfig({
  plugins: [
    UnoCSS({
      presets: [presetUno(), presetAttributify()],
      // Extend the content pipeline to also handle .js extension imports that
      // come from workspace packages resolved via the alias below.
      content: {
        pipeline: {
          include: [/\.(vue|svelte|[jt]sx?|mdx?|astro|html)($|\?)/],
        },
      },
    }),
    react(),
  ],

  // Point @ema-agent/desktop-ui directly at its TypeScript source so Vite
  // processes the TSX files through its transform pipeline (and UnoCSS can
  // extract class names from them) instead of loading the pre-built dist/.
  resolve: {
    alias: {
      '@ema-agent/desktop-ui': resolve(__dirname, '../../packages/desktop-ui/src/index.ts'),
      '@ema-agent/live2d-react': resolve(__dirname, '../../packages/live2d-react/src/index.ts'),
    },
  },

  // Exclude workspace packages from Vite's esbuild pre-bundler so they pass
  // through the full transform pipeline where UnoCSS can extract class names.
  optimizeDeps: {
    exclude: ['@ema-agent/desktop-ui', '@ema-agent/contracts'],
  },

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
    rollupOptions: {
      input: {
        main:     resolve(__dirname, 'index.html'),
        chat:     resolve(__dirname, 'chat.html'),
        settings: resolve(__dirname, 'settings.html'),
      },
    },
  },
});
