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

test('the real model renders under the packaged CSP without JavaScript eval', { timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'ema-live2d-test-'));
  let browser;
  let server;
  try {
    const config = JSON.parse(await readFile(path.join(desktop, 'src-tauri/tauri.conf.json'), 'utf8'));
    const policy = config.app.security.csp;
    assert.ok(!policy['script-src'].split(/\s+/u).includes("'unsafe-eval'"));
    const csp = Object.entries(policy).map(([name, value]) => `${name} ${value}`).join('; ');
    const core = await readFile(path.join(desktop, 'public/cubism/live2dcubismcore.min.js'));
    const zip = new JSZip();
    await addModelFiles(zip, path.join(desktop, 'src-tauri/resources/characters/樱羽艾玛/live2d/ema'));
    const archive = await zip.generateAsync({ type: 'nodebuffer' });

    await build({
      configFile: false,
      root: desktop,
      logLevel: 'error',
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
      ['/model.zip', ['application/zip', archive]],
    ]);
    server = createServer((request, response) => {
      const resource = routes.get(request.url);
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
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => {
      const state = document.getElementById('root').dataset;
      return state.error || (state.ready && state.firstTick);
    });
    const state = await page.locator('#root').evaluate(element => ({ ...element.dataset }));
    assert.equal(state.error, undefined, state.error);
    assert.equal(state.ready, 'true');
    assert.equal(state.firstTick, 'true');
    assert.equal(await page.locator('canvas').count(), 1);
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
    assert.ok(coloredPixels > 10_000, `Expected a visible model, got ${coloredPixels} non-white pixels`);
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
