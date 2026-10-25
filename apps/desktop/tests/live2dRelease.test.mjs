import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import JSZip from 'jszip';
import { chromium } from 'playwright';
import { build } from 'vite';

const desktop = fileURLToPath(new URL('../', import.meta.url));

test('models render, animate, switch and release resources under the packaged CSP', { timeout: 180_000 }, async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'ema-live2d-test-'));
  let browser;
  let server;
  try {
    const config = JSON.parse(await readFile(path.join(desktop, 'src-tauri/tauri.conf.json'), 'utf8'));
    const policy = config.app.security.csp;
    assert.ok(!policy['script-src'].split(/\s+/u).includes("'unsafe-eval'"));
    const csp = Object.entries(policy).map(([name, value]) => `${name} ${value}`).join('; ');
    const core = await readFile(path.join(desktop, 'public/cubism/live2dcubismcore.min.js'));
    const modelDirectories = new Map([
      ['Ema', path.join(desktop, 'src-tauri/resources/characters/樱羽艾玛/live2d/ema')],
    ]);
    if (process.env.EMA_LIVE2D_SAMPLES_PATH) {
      for (const name of ['Hiyori', 'Haru', 'Wanko', 'Ren']) {
        modelDirectories.set(name, path.join(process.env.EMA_LIVE2D_SAMPLES_PATH, name));
      }
    }
    const archives = new Map();
    for (const [name, directory] of modelDirectories) {
      const zip = new JSZip();
      // Uploaded ZIPs may contain a non-ASCII parent folder instead of flat model files.
      await addModelFiles(zip, directory, '模型/');
      archives.set(name, await zip.generateAsync({ type: 'nodebuffer' }));
    }
    const broken = await JSZip.loadAsync(archives.get('Ema'));
    for (const filename of Object.keys(broken.files)) {
      if (filename.endsWith('.png')) broken.remove(filename);
    }
    archives.set('Broken', await broken.generateAsync({ type: 'nodebuffer' }));

    await build({
      configFile: false,
      root: desktop,
      logLevel: 'error',
      esbuild: { jsx: 'automatic' },
      resolve: {
        alias: [
          { find: '@ema-agent/live2d-react', replacement: path.resolve(desktop, '../../src/live2d-react/index.ts') },
          { find: '@laplace.live/pixijs-live2d', replacement: path.resolve(desktop, '../../src/live2d-react/node_modules/@laplace.live/pixijs-live2d/dist/index.js') },
        ],
      },
      build: {
        outDir: temporary,
        target: 'es2022',
        copyPublicDir: false,
        lib: {
          entry: path.join(desktop, 'tests/live2dRelease.browser.tsx'),
          formats: ['es'],
          fileName: () => 'stage.js',
        },
        rollupOptions: { output: { inlineDynamicImports: true } },
      },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    });
    const script = await readFile(path.join(temporary, 'stage.js'));
    const routes = new Map([
      ['/stage.js', ['text/javascript', script]],
      ['/core.js', ['text/javascript', core]],
    ]);
    server = createServer((request, response) => {
      const url = new URL(request.url, 'http://localhost');
      let resource = routes.get(url.pathname);
      if (url.pathname === '/model.zip') {
        const archive = archives.get(url.searchParams.get('name'));
        if (archive) resource = ['application/zip', archive];
      }
      if (resource) {
        response.writeHead(200, { 'Content-Type': resource[0] });
        response.end(resource[1]);
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': csp });
      response.end(`<!doctype html><html><head><meta charset="utf-8">
        <style>html,body,#root{margin:0;width:400px;height:720px;background:white}</style>
        </head><body><script src="/core.js"></script><div id="root"></div>
        <script type="module" src="/stage.js"></script></body></html>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({
      headless: true,
      channel: process.platform === 'win32' ? 'msedge' : undefined,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const page = await browser.newPage({ viewport: { width: 400, height: 720 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
      if (message.type() === 'warning') t.diagnostic(message.text());
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.live2DRegression);
    for (const name of modelDirectories.keys()) {
      const result = await page.evaluate(name => window.live2DRegression.verifyModel(name), name);
      t.diagnostic(JSON.stringify(result));
      assert.equal(result.previewWidth, 3072);
      assert.equal(result.previewHeight, 4096);
      assert.equal(result.canvasCount, 1);
      assert.deepEqual(errors, []);

      // Inspect the captured frame as well as readiness so an empty canvas cannot pass.
      const screenshot = await page.screenshot();
      const coloredPixels = await page.evaluate(async base64 => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index] < 240 || pixels[index + 1] < 240 || pixels[index + 2] < 240) count++;
        }
        return count;
      }, screenshot.toString('base64'));
      assert.ok(coloredPixels > 10_000, `${name}: expected a visible model, got ${coloredPixels} non-white pixels`);
    }
    const cleanup = await page.evaluate(() => window.live2DRegression.verifyCleanup());
    t.diagnostic(JSON.stringify(cleanup));
    assert.equal(cleanup.objectURLs, 0);
    assert.equal(cleanup.allModelsDestroyed, true);
    assert.equal(cleanup.failedImportClean, true);
    assert.equal(cleanup.asyncUnmountClean, true);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});

async function addModelFiles(zip, directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    const relative = prefix + entry.name;
    if (entry.isDirectory()) {
      await addModelFiles(zip, filename, `${relative}/`);
    } else {
      zip.file(relative, await readFile(filename));
    }
  }
}
