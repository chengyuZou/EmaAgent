// 组装 LocalHost 服务、监听本地端口，并协调桌面运行时就绪与安全退出。
import { serve } from '@hono/node-server';
import { Database } from '@ema-agent/storage';
import { buildServer } from './server.js';
import { HTTP_SERVER_TIMEOUTS } from './http/request-budget.js';
import { requireSharedSecret } from './auth.js';
import { CredentialFacade, requireCredentialMasterKey } from '@ema-agent/credential';
import { FileAccessFacade } from '@ema-agent/attachment';
import { wire } from './wiring/index.js';
import { createHttpRoutes } from './wiring/createHttpRoutes.js';
import {
  profileDbPath, dataDbPathFor, loadRegistry, activeDirEntry,
  ensureDataDirLayout, ensureProfileLayout, acquireLock,
} from './storage-locations/index.js';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { verifyLocalHostBuildIntegrity } from './build-integrity.js';
import { publishRuntimeReady } from './bootstrap/readiness.js';

// 开发态直接运行 TypeScript；生产态拒绝缺失、陈旧或被混入旧文件的 dist。
verifyLocalHostBuildIntegrity(import.meta.url);

const PORT_DEFAULT = 3421;
const PORT_MAX     = 3430;

async function findOpenPort(start: number, max: number): Promise<number> {
  for (let port = start; port <= max; port++) {
    const available = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => { server.close(); resolve(true); });
      server.listen(port, '127.0.0.1');
    });
    if (available) return port;
  }
  throw new Error(`No available port in range ${start}–${max}`);
}

async function main() {
  // 认证配置必须先于数据库、锁文件和监听端口完成校验，禁止无密钥启动。
  const sharedSecret = requireSharedSecret();
  const credentialMasterKey = requireCredentialMasterKey();
  const credentials = new CredentialFacade(credentialMasterKey);
  const fileAccess = new FileAccessFacade(credentialMasterKey);

  // ── 1. Resolve storage locations ───────────────────────────────────────────
  const registry  = loadRegistry();
  const activeDir = activeDirEntry(registry);
  ensureProfileLayout();
  ensureDataDirLayout(activeDir.path);

  const profilePath = profileDbPath();
  const dataPath    = dataDbPathFor(activeDir.path);

  // ── 2. Lockfile (refuse to start if another instance has same dataDir) ─────
  const lock = acquireLock(activeDir.path);
  if (!lock.acquired) {
    console.error(
      `[local-host] another EmaAgent instance is already using "${activeDir.path}".\n` +
      `       conflict: hostname=${lock.conflict.hostname} pid=${lock.conflict.pid}\n` +
      `       refusing to start to avoid SQLite write conflicts.`,
    );
    process.exit(1);
  }

  // ── 3. Open + migrate both DBs ─────────────────────────────────────────────
  const profileDb = new Database({ path: profilePath, kind: 'profile' });
  const dataDb    = new Database({ path: dataPath,    kind: 'data' });
  profileDb.migrate();
  dataDb.migrate();
  console.log(`[storage] profile v${profileDb.currentVersion()} at ${profilePath}`);
  console.log(`[storage] data    v${dataDb.currentVersion()} at ${dataPath}`);
  console.log(`[storage] active dataDir: ${activeDir.name} (${activeDir.path})`);

  // ── 4. Wire + start ────────────────────────────────────────────────────────
  const bindings = wire({
    profileDb,
    dataDb,
    activeDataDir: activeDir.path,
    credentials,
    fileAccess,
  });

  await bindings.lifecycle.start();
  const app = buildServer(createHttpRoutes(bindings), sharedSecret);

  const port = await findOpenPort(PORT_DEFAULT, PORT_MAX);

  let clearRuntimeReady: (() => void) | null = null;
  const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
    clearRuntimeReady = publishRuntimeReady(info.port);
    console.log(`[local-host] ema-local-host listening on http://127.0.0.1:${info.port}`);
  });
  // 只限制请求头和请求体的接收时间，不限制可能运行数小时的 Agent/Task。
  if ('headersTimeout' in server) {
    server.headersTimeout = HTTP_SERVER_TIMEOUTS.headersMs;
  }
  if ('requestTimeout' in server) {
    server.requestTimeout = HTTP_SERVER_TIMEOUTS.requestBodyMs;
  }

  // Graceful shutdown — drain memory work, stop accepting requests, close DBs.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[local-host] shutting down...');
    void (async () => {
      try { await bindings.lifecycle.shutdown(); } catch { /* swallow */ }
      clearRuntimeReady?.();
      lock.release();
      server.close(() => {
        profileDb.close();
        dataDb.close();
        process.exit(0);
      });
    })();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

// Only run main() when this file is the process entry point. Importing it
// as a library (e.g. from `apps/cli/`) must NOT spin up the sidecar.
const isMain = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main().catch((err) => {
    console.error('[local-host] fatal startup error', err);
    process.exit(1);
  });
}
