#!/usr/bin/env node
import { Database } from './database.js';
import path from 'node:path';
import os   from 'node:os';
import fs   from 'node:fs';

// ── CLI: migrate profile + data DBs ──────────────────────────────────────────
//
// Usage:
//   tsx src/migrate-cli.ts                      # apply both
//   tsx src/migrate-cli.ts --status             # show versions
//   tsx src/migrate-cli.ts --data-dir D:\X      # override active dataDir
//
// Default paths:
//   profile.db  → ~/.ema-agent/profile.db
//   data.db     → ~/.ema-agent/data.db  (V1 default; UI lets users move it)

const HOME = os.homedir();

const dataDir    = process.argv.includes('--data-dir')
  ? process.argv[process.argv.indexOf('--data-dir') + 1] ?? path.join(HOME, '.ema-agent')
  : path.join(HOME, '.ema-agent');

const profilePath = path.join(HOME, '.ema-agent', 'profile.db');
const dataPath    = path.join(dataDir, 'data.db');

fs.mkdirSync(path.dirname(profilePath), { recursive: true });
fs.mkdirSync(path.dirname(dataPath),    { recursive: true });

const profile = new Database({ path: profilePath, kind: 'profile' });
const data    = new Database({ path: dataPath,    kind: 'data' });

const status = process.argv.includes('--status');
if (status) {
  console.log(`profile.db @ ${profilePath}  →  v${profile.currentVersion()}`);
  console.log(`data.db    @ ${dataPath}     →  v${data.currentVersion()}`);
} else {
  profile.migrate();
  data.migrate();
  console.log(`profile.db migrated to v${profile.currentVersion()}`);
  console.log(`data.db    migrated to v${data.currentVersion()}`);
}

profile.close();
data.close();
