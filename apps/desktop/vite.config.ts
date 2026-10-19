import { defineConfig }               from 'vite';
import react                           from '@vitejs/plugin-react';
import UnoCSS                          from 'unocss/vite';
import presetUno                       from '@unocss/preset-uno';
import presetAttributify               from '@unocss/preset-attributify';
import { resolve }                     from 'node:path';

// Tauri 开发页面使用 1420, HMR 使用 1421, public/ 资源从网站根路径读取.

export default defineConfig({
  plugins: [
    UnoCSS({
      presets: [presetUno(), presetAttributify()],
      // WebView2 的 button/pre 默认背景会盖住透明材质, 在业务样式加载前清除.
      preflights: [
        {
          getCSS: () =>
            `button,[role="button"]{background:transparent;border:none;padding:0;cursor:pointer;}` +
            `pre,code{background:transparent;}`,
        },
      ],
      // 工作区包的 .js 路径实际指向 TSX 源码, 也需要参与工具类提取.
      content: {
        pipeline: {
          include: [/\.(vue|svelte|[jt]sx?|mdx?|astro|html)($|\?)/],
        },
      },
    }),
    react(),
  ],

  // UI, Tool UI 和 Live2D 直接读取源码, 不依赖 dist 更新触发预打包缓存失效.
  // 后端实现只允许类型导入, 避免把 Node 代码打进浏览器.
  resolve: {
    alias: [
      // Shared setting definitions must use current source in both Dev and Release.
      { find: /^@ema-agent\/server\/settings$/, replacement: resolve(__dirname, '../server/src/settings/definitions.ts') },
      { find: /^@ema-agent\/settings\/definition$/, replacement: resolve(__dirname, '../../src/settings/types.ts') },
      { find: /^@ema-agent\/agent\/settings$/, replacement: resolve(__dirname, '../../src/agent/settings.ts') },
      { find: /^@ema-agent\/attachments\/settings$/, replacement: resolve(__dirname, '../../src/attachments/settings.ts') },
      { find: /^@ema-agent\/compact\/settings$/, replacement: resolve(__dirname, '../../src/compact/settings.ts') },
      { find: /^@ema-agent\/permission\/settings$/, replacement: resolve(__dirname, '../../src/permission/settings.ts') },
      { find: /^@ema-agent\/skills\/settings$/, replacement: resolve(__dirname, '../../src/skills/settings.ts') },
      { find: /^@ema-agent\/tools\/settings$/, replacement: resolve(__dirname, '../../src/tools/settings.ts') },
      { find: /^@ema-agent\/sandbox\/settings$/, replacement: resolve(__dirname, '../../src/sandbox/settings.ts') },
      { find: /^@ema-agent\/vishot-capture\/settings$/, replacement: resolve(__dirname, '../../src/vishot-capture/settings.ts') },
      { find: /^@ema-agent\/tools\/background\/settings$/, replacement: resolve(__dirname, '../../src/tools/background/settings.ts') },
      { find: /^@ema-agent\/ui$/, replacement: resolve(__dirname, '../../src/ui/index.ts') },
      { find: /^@ema-agent\/ui\/utils$/, replacement: resolve(__dirname, '../../src/ui/utils/index.ts') },
      { find: '@ema-agent/builtin-tools/ui', replacement: resolve(__dirname, '../../src/builtin-tools/ui.ts') },
      { find: '@ema-agent/live2d-react', replacement: resolve(__dirname, '../../src/live2d-react/index.ts') },
      // 角色名单是纯函数, 浏览器不加载包含 Node 检索实现的 Narrative 根入口.
      { find: '@ema-agent/narrative/isWitchTrialCharacter', replacement: resolve(__dirname, '../../src/narrative/isWitchTrialCharacter.ts') },
      // 两份外观常量没有 Node 依赖, 前后端共用键名和默认值.
      { find: '@ema-agent/server/settings/themeCatalog.js', replacement: resolve(__dirname, '../../apps/server/src/settings/themeCatalog.ts') },
      { find: '@ema-agent/server/settings/wallpaperCatalog.js', replacement: resolve(__dirname, '../../apps/server/src/settings/wallpaperCatalog.ts') },
    ],
  },

  // 工作区前端包不进入预打包缓存, 源码更新时直接重新转换.
  optimizeDeps: {
    // oxc-parser 的可选 WASM 在 Windows 不可用, 不让它进入浏览器预打包.
    exclude: ['@ema-agent/ui', '@ema-agent/live2d-react', 'oxc-parser'],
    // 与正式构建的现代 WebView 语法目标保持一致.
    esbuildOptions: { target: 'es2022' },
  },

  // 保留终端里的 Rust 编译错误.
  clearScreen: false,
  worker: { format: 'es' },
  server: {
    port:        1420,
    strictPort:  true,
    host:        '127.0.0.1',
    hmr:         { protocol: 'ws', host: '127.0.0.1', port: 1421 },
  },
  build: {
    // 运行环境为现代 WebView2 与 WKWebView.
    target:       ['es2022', 'chrome105', 'safari15'],
    minify:       'esbuild',
    sourcemap:    true,
    outDir:       'dist',
    emptyOutDir:  true,
    // Worklet 必须以本地脚本文件加载, 不能因为体积小而内联成被 CSP 拦截的 data: URL.
    assetsInlineLimit: file => {
      if (file.endsWith('/wlipsync/dist/audio-processor.js')) return false;
      return undefined;
    },
    rollupOptions: {
      input: {
        stage: resolve(__dirname, 'index.html'),
        main: resolve(__dirname, 'main.html'),
      },
      // 该 WASM 仅服务构建工具, 不打进 WebView.
      external: ['@oxc-parser/binding-wasm32-wasi'],
    },
  },
});
