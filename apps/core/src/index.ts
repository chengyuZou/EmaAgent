import { serve } from '@hono/node-server';
import { Database } from '@ema-agent/storage';
import { buildServer } from './server.js';
import { wire, configureBridge } from './wiring.js';
import { startBackgroundWork } from './wiring/index.js';
import {
  profileDbPath, dataDbPathFor, loadRegistry, activeDirEntry,
  ensureDataDirLayout, ensureProfileLayout, acquireLock,
} from './storage-locations/index.js';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ── Public re-exports (for embedding cores: CLI, tests, future hosts) ────────
// The HTTP sidecar (this file's main()) is only one of several possible
// consumers of the assembled runtime. Exposing `wire`, `startBackgroundWork`,
// and `Orchestrator` lets a CLI import them directly and consume the
// AsyncIterable<EmaStreamEvent> without any Hono dependency.
export { wire, configureBridge, resolveBridgeUrl } from './wiring.js';
export { startBackgroundWork } from './wiring/index.js';
export type { AppBindings, BuildBindingsArgs, BackgroundHandle } from './wiring/index.js';
export { Orchestrator }     from './orchestrator/orchestrator.js';
export type {
  TurnRequest as OrchestratorTurnRequest,
  TurnResult  as OrchestratorTurnResult,
} from './orchestrator/orchestrator.js';

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
      `[core] another EmaAgent instance is already using "${activeDir.path}".\n` +
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
  const bindings = wire({ profileDb, dataDb, activeDataDir: activeDir.path });

  // Ensure at least one KB exists; if registry is empty auto-create a default
  // KB under the active dataDir so the app works out of the box.
  const defaultKbPath = path.join(activeDir.path, 'kb-default');
  await bindings.kb.ensureDefault(defaultKbPath);
  // Open + HNSW-init all registered KBs (fire-and-forget; search falls back
  // to SQL cosine until HNSW builds, same as before).
  void bindings.kb.initAll().catch((err) => {
    console.warn('[kb] initAll() failed:', err);
  });
  const bgWork   = startBackgroundWork(bindings);
  const app = buildServer(bindings);

  const port = await findOpenPort(PORT_DEFAULT, PORT_MAX);

  // Fire-and-forget: push provider config to bridge after server is up.
  // Bridge may not be running in dev — failures are logged as warnings.
  void configureBridge(profileDb, bindings.narrative);

  const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
    console.log(`[core] ema-core listening on http://127.0.0.1:${info.port}`);
  });

  // Graceful shutdown — drain memory work, stop accepting requests, close DBs.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[core] shutting down...');
    void (async () => {
      try { await bgWork.shutdown(); } catch { /* swallow */ }
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
    console.error('[core] fatal startup error', err);
    process.exit(1);
  });
}
