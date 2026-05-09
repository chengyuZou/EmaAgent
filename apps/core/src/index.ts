import { serve } from '@hono/node-server';
import { Database } from '@ema-agent/storage';
import { buildServer } from './server.js';
import { wire } from './wiring.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

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
      const net = require('net') as typeof import('net');
      const server = net.createServer();
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
  const app = buildServer(bindings);

  const port = await findOpenPort(PORT_DEFAULT, PORT_MAX);

  const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
    console.log(`[core] ema-core listening on http://127.0.0.1:${info.port}`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('[core] shutting down...');
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[core] fatal startup error', err);
  process.exit(1);
});
