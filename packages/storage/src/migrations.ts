import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const LATEST_VERSION = 1;

export class MigrationsRunner {
  constructor(private readonly db: Database.Database) {}

  run(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number;
    if (current >= LATEST_VERSION) return;

    for (let v = current + 1; v <= LATEST_VERSION; v++) {
      const file = path.join(MIGRATIONS_DIR, `${String(v).padStart(3, '0')}_initial.sql`);
      if (!fs.existsSync(file)) {
        throw new Error(`Migration file not found: ${file}`);
      }
      const sql = fs.readFileSync(file, 'utf8');
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db.pragma(`user_version = ${v}`);
      })();
    }
  }

  currentVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number;
  }
}
