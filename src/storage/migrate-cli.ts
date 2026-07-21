#!/usr/bin/env node
import { Database } from './database.js';
import path from 'node:path';
import os   from 'node:os';
import fs   from 'node:fs';

// ── CLI:迁移 profile + data DB ───────────────────────────────────────────────
//
// 用法:
//   tsx src/migrate-cli.ts                      # 两者都执行
//   tsx src/migrate-cli.ts --status             # 查看版本
//   tsx src/migrate-cli.ts --data-dir D:\X      # 覆盖激活的 dataDir
//
// 默认路径:
//   profile.db  -> ~/.ema-agent/profile.db
//   data.db     -> ~/.ema-agent/data.db  (V1 默认;UI 允许用户移动)

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
  console.log(`profile.db @ ${profilePath}  ->  v${profile.currentVersion()}`);
  console.log(`data.db    @ ${dataPath}     ->  v${data.currentVersion()}`);
} else {
  profile.migrate();
  data.migrate();
  console.log(`profile.db migrated to v${profile.currentVersion()}`);
  console.log(`data.db    migrated to v${data.currentVersion()}`);
}

profile.close();
data.close();
