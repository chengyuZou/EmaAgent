import type { SqlMigration } from "./migrations.js";
import { MIGRATIONS } from "./migrations.js";

/** node:sqlite 与测试替身都需要满足的最小数据库接口。 */
export interface SqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): {
    run(params?: Record<string, unknown> | unknown[]): unknown;
    get<T = unknown>(params?: Record<string, unknown> | unknown[]): T | undefined;
    all<T = unknown>(params?: Record<string, unknown> | unknown[]): T[];
  };
}

interface MigrationRow {
  id: string;
}

/**
 * 执行所有未应用迁移。
 *
 * 迁移状态写在 schema_migrations 表里，应用层不需要关心当前数据库从哪个旧版本升级。
 */
export function migrateDatabase(
  db: SqliteDatabaseLike,
  migrations: readonly SqlMigration[] = MIGRATIONS,
): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`);

  const appliedRows = db.prepare("SELECT id FROM schema_migrations").all<MigrationRow>();
  const appliedIds = new Set(appliedRows.map((row) => row.id));

  for (const migration of migrations) {
    if (appliedIds.has(migration.id)) {
      continue;
    }

    db.exec("BEGIN");
    try {
      for (const statement of migration.statements) {
        db.exec(statement);
      }

      db.prepare(
        "INSERT INTO schema_migrations (id, name, applied_at) VALUES (:id, :name, :appliedAt)",
      ).run({
        id: migration.id,
        name: migration.name,
        appliedAt: Date.now(),
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
