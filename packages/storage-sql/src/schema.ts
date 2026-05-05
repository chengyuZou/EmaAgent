/**
 * SQLite 正向迁移 — user_version PRAGMA 追踪。
 *
 * 无 ORM、无 down 迁移。每次只追加新 migration 函数。
 */

import type { Database } from "better-sqlite3"

const LATEST_VERSION = 5

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.some((row) => row.name === column)
}

function tableExists(db: Database, table: string): boolean {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(table) as { name: string } | undefined
  return row !== undefined
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
    `)
  },

  2: (db) => {
    if (!hasColumn(db, "turns", "error_code")) {
      db.exec("ALTER TABLE turns ADD COLUMN error_code TEXT;")
    }
    if (!hasColumn(db, "turns", "error_message")) {
      db.exec("ALTER TABLE turns ADD COLUMN error_message TEXT;")
    }
  },

  3: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        status TEXT NOT NULL,
        text_preview TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_attachments_session_id_created_at ON attachments(session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS attachment_chunks (
        id TEXT PRIMARY KEY,
        attachment_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_attachment_chunks_attachment_id ON attachment_chunks(attachment_id, chunk_index);
    `)
  },

  4: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_facts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_memory_facts_session_kind ON memory_facts(session_id, kind);

      CREATE TABLE IF NOT EXISTS session_summaries (
        session_id TEXT PRIMARY KEY,
        summary_text TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        covered_message_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS telemetry_events (
        id TEXT PRIMARY KEY,
        trace_id TEXT,
        request_id TEXT,
        session_id TEXT,
        type TEXT NOT NULL,
        level TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_telemetry_events_created_at ON telemetry_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_telemetry_events_request_id ON telemetry_events(request_id);
    `)
  },

  5: (db) => {
    // Provider 配置
    if (!tableExists(db, "provider_configs")) {
      db.exec(`
        CREATE TABLE provider_configs (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          category TEXT NOT NULL,
          kind TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          configured INTEGER NOT NULL DEFAULT 1,
          credential_id TEXT,
          base_url TEXT,
          api_key_encrypted TEXT,
          headers_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `)
    }

    // Model 角色绑定（每个 role 唯一）
    if (!tableExists(db, "model_bindings")) {
      db.exec(`
        CREATE TABLE model_bindings (
          id TEXT PRIMARY KEY,
          role TEXT NOT NULL UNIQUE,
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_model_bindings_role ON model_bindings(role);
      `)
    }

    // 权限授予持久化
    if (!tableExists(db, "permission_grants")) {
      db.exec(`
        CREATE TABLE permission_grants (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          decision TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT 'once',
          risk TEXT NOT NULL,
          path_pattern TEXT,
          decided_at INTEGER NOT NULL,
          expires_at INTEGER,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_permission_grants_session_tool ON permission_grants(session_id, tool_name);
      `)
    }
  },
}

export function migrate(db: Database): void {
  const currentVersion = db.pragma("user_version", { simple: true }) as number

  const transaction = db.transaction(() => {
    for (let v = currentVersion + 1; v <= LATEST_VERSION; v++) {
      const migration = MIGRATIONS[v]
      if (migration) {
        migration(db)
      }
      db.pragma(`user_version = ${v}`)
    }
  })

  transaction()
}
