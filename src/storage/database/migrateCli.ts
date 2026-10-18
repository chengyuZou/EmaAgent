#!/usr/bin/env node
import { Database } from './database.js';
import path from 'node:path';
import os   from 'node:os';
import fs   from 'node:fs';

// --status 也会创建目录并打开数据库, 但不执行迁移.

const profileRoot = path.resolve(process.env['EMA_PROFILE_DIR'] ?? path.join(os.homedir(), '.ema-agent'));

const dataDir    = process.argv.includes('--data-dir')
  ? process.argv[process.argv.indexOf('--data-dir') + 1] ?? path.join(profileRoot, 'data')
  : path.join(profileRoot, 'data');

const profilePath = path.join(profileRoot, 'profile.db');
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
