import { defineConfig }               from 'vite';
import react                           from '@vitejs/plugin-react';
import UnoCSS                          from 'unocss/vite';
import presetUno                       from '@unocss/preset-uno';
import presetAttributify               from '@unocss/preset-attributify';
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
      // UnoCSS's built-in preflight doesn't reset button/pre UA defaults.
      // WebView2 gives <button> a system-grey background and <pre> a white one —
      // both bleed through when bg-transparent is used on a dark UI.
      preflights: [
        {
          getCSS: () =>
            `button,[role="button"]{background:transparent;border:none;padding:0;cursor:pointer;}` +
            `pre,code{background:transparent;}` +
            `::-webkit-scrollbar{width:5px;height:5px;}` +
            `::-webkit-scrollbar-track{background:transparent;}` +
            `::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.1);border-radius:3px;}` +
            `::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.2);}`,
        },
      ],
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

  // Point workspace packages directly at their TypeScript source so Vite
  // processes the TSX files through its transform pipeline (and UnoCSS can
  // extract class names from them) instead of loading the pre-built dist/.
  //
  // @ema-agent/ui MUST be aliased too: without this, Vite resolves it via
  // package.json exports -> dist/ and pre-bundles dist into .vite/deps. Vite
  // only re-optimizes pre-bundled deps when package.json/lockfile change, NOT
  // when dist content changes - so a rebuilt ui/dist was silently served stale
  // from .vite/deps (the same trap that bit live2d-react's registerTicker fix).
  // Aliasing to src makes dev read the live source on every reload.
  resolve: {
    alias: {
      '@ema-agent/desktop-ui': resolve(__dirname, '../desktop-ui/src/index.ts'),
      '@ema-agent/ui':         resolve(__dirname, '../../src/ui'),
      '@ema-agent/live2d-react': resolve(__dirname, '../../src/live2d-react/index.ts'),
    },
  },

  // Exclude workspace packages from Vite's esbuild pre-bundler so they pass
  // through the full transform pipeline where UnoCSS can extract class names.
  //
  // live2d-react is here too: Vite only re-optimizes pre-bundled deps when
  // package.json/lockfile change, NOT when a workspace dep's dist content
  // changes — so a rebuilt live2d-react/dist was silently served stale from
  // .vite/deps cache (the registerTicker fix never reached the running app).
  // Excluding it makes Vite read its current dist on every reload.
  optimizeDeps: {
    // 'oxc-parser' excluded so its optional wasm binding (absent on Windows)
    // never enters the pre-bundler. Vite's esbuildOptions type omits
    // `external`, so exclusion is the only supported lever here.
    exclude: ['@ema-agent/desktop-ui', '@ema-agent/ui', '@ema-agent/contracts', '@ema-agent/live2d-react', 'oxc-parser'],
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
      // oxc-parser is a build-time tool dragged in via unocss's dependency
      // graph; its optional wasm binding doesn't exist on Windows and must
      // never be bundled into the webview.
      external: ['@oxc-parser/binding-wasm32-wasi'],
    },
  },
});
