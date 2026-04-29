import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { migrate } from "./schema.js";

export function createDatabaseConnection(dbPath: string): DatabaseType {
  const db = new Database(dbPath);
  
  // ==========================================
  // 桌面端读写并发最优配置
  // ==========================================
  db.pragma('journal_mode = WAL');   // 启用 WAL 模式极大提升并发和写入性能
  db.pragma('synchronous = NORMAL'); // WAL 下可安全降为 NORMAL，比 FULL 更快
  db.pragma('foreign_keys = ON');    // 强制由于 Schema 设置了 ON DELETE CASCADE，必须开启
  db.pragma('temp_store = MEMORY');  // 在内存中处理临时表与索引排序
  db.pragma('cache_size = -64000');  // 分配 64MB Cache 提升命中率（默认 2MB）

  // 应用表结构与迁移
  migrate(db);
  
  return db;
}