import { createDatabaseConnection } from "./connection.js";
import { createSessionRepository } from "./sessions.js";
import { createTurnRepository } from "./turns.js";
import { createMessageRepository } from "./messages.js";
import { createArtifactRepository } from "./artifacts.js";

/**
 * 组装 SQLite 本地存储引擎
 * @param dbPath 本地数据库的绝对路径（由外层根据 app.getPath('userData') 注入）
 */
export function createSqliteStorage(dbPath: string) {
  const db = createDatabaseConnection(dbPath);

  return {
    sessions: createSessionRepository(db),
    turns: createTurnRepository(db),
    messages: createMessageRepository(db),
    artifacts: createArtifactRepository(db),
    
    // Tauri 应用退出或 sidecar 关闭时调用
    close: () => {
      // 在 WAL 模式关闭前，可以强制打一次 checkpoint 缩小 shm/wal 体积（可选）
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    }
  };
}

export type SqliteStorage = ReturnType<typeof createSqliteStorage>;