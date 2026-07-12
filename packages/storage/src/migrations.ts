import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * 两条独立迁移流——profile 和 data,各自由所属 DB 的 `user_version` pragma 追踪。
 *
 *   profile.db 迁移位于 `migrations/profile/`
 *   data.db    迁移位于 `migrations/data/`
 *
 * 每条流独立:profile 可以在 v3 而 data 在 v7(反之亦然)。版本号只在各自文件夹内推进。
 */
export type DatabaseKind = 'profile' | 'data' | 'kb';

export class MigrationsRunner {
  constructor(
    private readonly db:   Database.Database,
    private readonly kind: DatabaseKind,
  ) {}

  /**
   * 应用 `migrations/{kind}/` 下所有待执行迁移。
   *
   * 每条迁移与 `user_version` 自增在单个事务内执行,
   * 不会残留半应用的迁移。
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
