#!/usr/bin/env node
import { Database } from './database.js';
import path from 'node:path';
import os from 'node:os';

const dbPath = path.join(os.homedir(), '.ema-agent', 'ema.db');
const db = new Database({ path: dbPath });

const args = process.argv.slice(2);
if (args.includes('--status')) {
  console.log(`Current user_version: ${db.currentVersion()}`);
} else {
  db.migrate();
  console.log(`Migrated to version ${db.currentVersion()}`);
}
db.close();
