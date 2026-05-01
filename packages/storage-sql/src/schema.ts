import type { Database } from "better-sqlite3";

// 我们使用 SQLite 原生的 user_version pragma 追踪版本
const LATEST_VERSION = 2;

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

const MIGRATIONS: Record<number, (db: Database) => void> = {
  1: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        last_mode TEXT NOT NULL DEFAULT 'chat',
        full_access INTEGER NOT NULL DEFAULT 1,
        active_skills TEXT NOT NULL DEFAULT '[]',
        title_status TEXT NOT NULL DEFAULT 'default',
        title_updated_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content_blocks TEXT NOT NULL DEFAULT '[]',
        request_id TEXT,
        status TEXT NOT NULL DEFAULT 'complete',
        error_code TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session_id_created_at ON messages(session_id, created_at);

      CREATE TABLE IF NOT EXISTS turns (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        model_id TEXT,
        provider_id TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        usage_json TEXT,
        error_code TEXT,
        error_message TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_turns_session_id_started_at ON turns(session_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        mime TEXT NOT NULL DEFAULT 'text/plain',
        target_paths TEXT,
        params TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        payload_type TEXT NOT NULL DEFAULT 'inline',
        payload_content TEXT,
        binary_base64 TEXT,
        content_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_session_id_created_at ON artifacts(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_artifacts_request_id ON artifacts(request_id);
    `);
  },

  2: (db) => {
    if (!hasColumn(db, "turns", "error_code")) {
      db.exec(`ALTER TABLE turns ADD COLUMN error_code TEXT;`);
    }
    if (!hasColumn(db, "turns", "error_message")) {
      db.exec(`ALTER TABLE turns ADD COLUMN error_message TEXT;`);
    }
  },
};

export function migrate(db: Database): void {
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  
  // 采用事务包裹迁移，失败自动回滚
  const transaction = db.transaction(() => {
    for (let v = currentVersion + 1; v <= LATEST_VERSION; v++) {
      const migration = MIGRATIONS[v];
      if (migration) {
        migration(db);
      }
      db.pragma(`user_version = ${v}`);
    }
  });
  
  transaction();
}
