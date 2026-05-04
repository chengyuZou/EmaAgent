/**
 * SQLite 数据库连接管理。
 *
 * 配置 PRAGMAs，执行迁移，返回配置好的 Database 实例。
 */

import Database from "better-sqlite3"
import type { Database as DatabaseType } from "better-sqlite3"
import { migrate } from "./schema.js"
import { createFtsIndexes } from "./fts.js"

export function createDatabaseConnection(dbPath: string): DatabaseType {
  const db = new Database(dbPath)

  db.pragma("journal_mode = WAL")
  db.pragma("synchronous = NORMAL")
  db.pragma("foreign_keys = ON")
  db.pragma("temp_store = MEMORY")
  db.pragma("cache_size = -64000")   // 64 MB

  migrate(db)
  createFtsIndexes(db)

  return db
}
