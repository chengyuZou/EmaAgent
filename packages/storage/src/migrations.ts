import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Two independent migration streams — profile and data — each tracked by its
 * own DB's `user_version` pragma.
 *
 *   profile.db migrations live under `migrations/profile/`
 *   data.db    migrations live under `migrations/data/`
 *
 * Each stream is independent: profile can be on version 3 while data is on
 * version 7 (or vice versa). Versions advance only inside their own folder.
 */
export type DatabaseKind = 'profile' | 'data';

export class MigrationsRunner {
  constructor(
    private readonly db:   Database.Database,
    private readonly kind: DatabaseKind,
  ) {}

  /**
   * Apply every pending migration in `migrations/{kind}/`.
   *
   * Each migration runs inside a single transaction together with the
   * `user_version` bump, so a half-applied migration cannot be left behind.
   */
  run(): void {
    const folder  = path.join(MIGRATIONS_DIR, this.kind);
    const entries = fs.readdirSync(folder)
      .filter(f => f.endsWith('.sql'))
      .sort();

    const current = this.db.pragma('user_version', { simple: true }) as number;
    const latest  = entries.length;

    for (let v = current + 1; v <= latest; v++) {
      const prefix   = String(v).padStart(3, '0') + '_';
      const filename = entries.find(f => f.startsWith(prefix));
      if (!filename) {
        throw new Error(`[${this.kind}] migration ${v} not found in ${folder}`);
      }
      const file = path.join(folder, filename);
      const sql  = fs.readFileSync(file, 'utf8');
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
