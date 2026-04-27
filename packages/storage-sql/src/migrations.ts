import { SQL_TABLES, createTableSql } from "./schema.js";
import type { SqlTableSpec } from "./schema.js";

/**
 * 版本化迁移定义。
 *
 * 每条迁移必须幂等，因为桌面端可能在开发期被多次启动。正式接入 drizzle-kit 后，
 * 这里的 SQL 可以作为 0001 初始迁移的基准。
 */
export interface SqlMigration {
  /** 递增版本号。 */
  id: string;
  /** 简短说明，写入 schema_migrations 方便排查。 */
  name: string;
  /** 要顺序执行的 SQL 列表。 */
  statements: readonly string[];
}

/** V1 初始表结构迁移。 */
export const MIGRATIONS: readonly SqlMigration[] = [
  {
    id: "0001",
    name: "ema_v1_initial_schema",
    statements: [
      "PRAGMA foreign_keys = ON",
      `CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`,
      ...SQL_TABLES.flatMap((table) => {
        const spec: SqlTableSpec = table;
        return [createTableSql(spec), ...(spec.extras ?? [])];
      }),
    ],
  },
];
