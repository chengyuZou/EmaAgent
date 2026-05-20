import { serve } from '@hono/node-server';
import { Database } from '@ema-agent/storage';
import { buildServer } from './server.js';
import { wire, configureBridge } from './wiring.js';
import { startBackgroundWork } from './wiring/index.js';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// ── Public re-exports (for embedding cores: CLI, tests, future hosts) ────────
// The HTTP sidecar (this file's main()) is only one of several possible
// consumers of the assembled runtime. Exposing `wire`, `startBackgroundWork`,
// and `Orchestrator` lets a CLI import them directly and consume the
// AsyncIterable<EmaStreamEvent> without any Hono dependency.
export { wire, configureBridge, resolveBridgeUrl } from './wiring.js';
export { startBackgroundWork } from './wiring/index.js';
export type { AppBindings, BackgroundHandle } from './wiring/index.js';
export { Orchestrator }     from './orchestrator/orchestrator.js';
export type {
  TurnRequest as OrchestratorTurnRequest,
  TurnResult  as OrchestratorTurnResult,
} from './orchestrator/orchestrator.js';

const PORT_DEFAULT = 3421;
const PORT_MAX     = 3430;

function resolveDbPath(): string {
  const dataDir = process.env['EMA_DATA_DIR']
    ?? path.join(os.homedir(), '.ema-agent');
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, 'ema.db');
}

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
  const dbPath = resolveDbPath();
  const db = new Database({ path: dbPath });
  db.migrate();
  console.log(`[storage] DB v${db.currentVersion()} at ${dbPath}`);

  const bindings = wire(db);
  const bgWork   = startBackgroundWork(bindings);
  const app = buildServer(bindings);

  const port = await findOpenPort(PORT_DEFAULT, PORT_MAX);

  // Fire-and-forget: push provider config to bridge after server is up.
  // Bridge may not be running in dev — failures are logged as warnings.
  void configureBridge(db, bindings.narrative);

  const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
    console.log(`[core] ema-core listening on http://127.0.0.1:${info.port}`);
  });

  // Graceful shutdown — drain memory work, stop accepting requests, close DB.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[core] shutting down...');
    void (async () => {
      try { await bgWork.shutdown(); } catch { /* swallow */ }
      server.close(() => {
        db.close();
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
