/**
 * SQLite 表结构声明。
 *
 * 这里先用轻量 TypeScript 描述表结构，避免在未安装 drizzle-orm 时阻断构建。
 * 字段命名和约束按文档中的 Day2 schema 落地，后续引入 drizzle-orm 后可一一映射为
 * sqliteTable 定义。
 */

/** SQLite 字段声明，用于开发期自检和文档化。 */
export interface SqlColumnSpec {
  /** 字段名。 */
  name: string;
  /** SQLite 类型与约束片段。 */
  definition: string;
}

/** SQLite 表声明。 */
export interface SqlTableSpec {
  /** 表名。 */
  name: string;
  /** 字段列表。 */
  columns: SqlColumnSpec[];
  /** 表级索引或虚表等附加 SQL。 */
  extras?: string[];
}

/** V1 需要的核心表。 */
export const SQL_TABLES = [
  {
    name: "sessions",
    columns: [
      { name: "id", definition: "TEXT PRIMARY KEY" },
      { name: "title", definition: "TEXT NOT NULL" },
      { name: "mode_last", definition: "TEXT NOT NULL DEFAULT 'chat'" },
      { name: "title_status", definition: "TEXT NOT NULL DEFAULT 'default'" },
      { name: "title_updated_at", definition: "INTEGER" },
      { name: "full_access", definition: "INTEGER NOT NULL DEFAULT 0" },
      { name: "active_skills_json", definition: "TEXT NOT NULL DEFAULT '[]'" },
      { name: "created_at", definition: "INTEGER NOT NULL" },
      { name: "updated_at", definition: "INTEGER NOT NULL" },
    ],
    extras: ["CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC)"],
  },
  {
    name: "messages",
    columns: [
      { name: "id", definition: "TEXT PRIMARY KEY" },
      { name: "session_id", definition: "TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE" },
      { name: "request_id", definition: "TEXT" },
      { name: "role", definition: "TEXT NOT NULL" },
      { name: "content", definition: "TEXT NOT NULL DEFAULT ''" },
      { name: "content_blocks_json", definition: "TEXT NOT NULL DEFAULT '[]'" },
      { name: "tool_call_id", definition: "TEXT" },
      { name: "tool_calls_json", definition: "TEXT" },
      { name: "created_at", definition: "INTEGER NOT NULL" },
    ],
    extras: [
      "CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at)",
      "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(message_id UNINDEXED, content)",
    ],
  },
  {
    name: "turns",
    columns: [
      { name: "request_id", definition: "TEXT PRIMARY KEY" },
      { name: "session_id", definition: "TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE" },
      { name: "mode", definition: "TEXT NOT NULL" },
      { name: "status", definition: "TEXT NOT NULL" },
      { name: "model_id", definition: "TEXT" },
      { name: "provider_id", definition: "TEXT" },
      { name: "started_at", definition: "INTEGER NOT NULL" },
      { name: "ended_at", definition: "INTEGER" },
      { name: "usage_json", definition: "TEXT" },
      { name: "cost_usd", definition: "REAL" },
    ],
    extras: ["CREATE INDEX IF NOT EXISTS idx_turns_session_started ON turns(session_id, started_at DESC)"],
  },
  {
    name: "steps",
    columns: [
      { name: "id", definition: "TEXT PRIMARY KEY" },
      { name: "request_id", definition: "TEXT NOT NULL REFERENCES turns(request_id) ON DELETE CASCADE" },
      { name: "type", definition: "TEXT NOT NULL" },
      { name: "status", definition: "TEXT NOT NULL" },
      { name: "title", definition: "TEXT NOT NULL" },
      { name: "detail_json", definition: "TEXT" },
      { name: "started_at", definition: "INTEGER" },
      { name: "ended_at", definition: "INTEGER" },
    ],
    extras: ["CREATE INDEX IF NOT EXISTS idx_steps_request ON steps(request_id)"],
  },
  {
    name: "stream_events",
    columns: [
      { name: "id", definition: "INTEGER PRIMARY KEY AUTOINCREMENT" },
      { name: "request_id", definition: "TEXT NOT NULL REFERENCES turns(request_id) ON DELETE CASCADE" },
      { name: "seq", definition: "INTEGER NOT NULL" },
      { name: "type", definition: "TEXT NOT NULL" },
      { name: "payload_json", definition: "TEXT NOT NULL" },
      { name: "created_at", definition: "INTEGER NOT NULL" },
    ],
    extras: ["CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_events_request_seq ON stream_events(request_id, seq)"],
  },
  {
    name: "artifacts",
    columns: [
      { name: "id", definition: "TEXT PRIMARY KEY" },
      { name: "request_id", definition: "TEXT NOT NULL REFERENCES turns(request_id) ON DELETE CASCADE" },
      { name: "kind", definition: "TEXT NOT NULL" },
      { name: "title", definition: "TEXT NOT NULL" },
      { name: "mime", definition: "TEXT NOT NULL" },
      { name: "payload_ref", definition: "TEXT NOT NULL" },
      { name: "target_path", definition: "TEXT" },
      { name: "status", definition: "TEXT NOT NULL DEFAULT 'ready'" },
      { name: "diff_base_hash", definition: "TEXT" },
      { name: "diff_head_hash", definition: "TEXT" },
      { name: "created_at", definition: "INTEGER NOT NULL" },
      { name: "updated_at", definition: "INTEGER NOT NULL" },
    ],
    extras: ["CREATE INDEX IF NOT EXISTS idx_artifacts_request ON artifacts(request_id)"],
  },
  {
    name: "attachments",
    columns: [
      { name: "id", definition: "TEXT PRIMARY KEY" },
      { name: "session_id", definition: "TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE" },
      { name: "file_name", definition: "TEXT NOT NULL" },
      { name: "mime", definition: "TEXT NOT NULL" },
      { name: "size_bytes", definition: "INTEGER NOT NULL" },
      { name: "sha256", definition: "TEXT NOT NULL" },
      { name: "storage_path", definition: "TEXT NOT NULL" },
      { name: "created_at", definition: "INTEGER NOT NULL" },
    ],
    extras: ["CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id)"],
  },
  {
    name: "attachment_chunks",
    columns: [
      { name: "id", definition: "TEXT PRIMARY KEY" },
      { name: "attachment_id", definition: "TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE" },
      { name: "chunk_index", definition: "INTEGER NOT NULL" },
      { name: "text", definition: "TEXT NOT NULL" },
      { name: "embedding_ref", definition: "TEXT" },
      { name: "token_count", definition: "INTEGER NOT NULL DEFAULT 0" },
    ],
    extras: ["CREATE UNIQUE INDEX IF NOT EXISTS idx_attachment_chunks_order ON attachment_chunks(attachment_id, chunk_index)"],
  },
  {
    name: "memory_items",
    columns: [
      { name: "id", definition: "TEXT PRIMARY KEY" },
      { name: "session_id", definition: "TEXT REFERENCES sessions(id) ON DELETE CASCADE" },
      { name: "namespace", definition: "TEXT NOT NULL" },
      { name: "kind", definition: "TEXT NOT NULL" },
      { name: "text", definition: "TEXT NOT NULL" },
      { name: "summary", definition: "TEXT" },
      { name: "salience", definition: "REAL NOT NULL DEFAULT 0" },
      { name: "last_used_at", definition: "INTEGER" },
      { name: "embedding_ref", definition: "TEXT" },
      { name: "created_at", definition: "INTEGER NOT NULL" },
      { name: "updated_at", definition: "INTEGER NOT NULL" },
    ],
    extras: ["CREATE INDEX IF NOT EXISTS idx_memory_items_lookup ON memory_items(namespace, kind, salience DESC)"],
  },
  {
    name: "provider_configs",
    columns: [
      { name: "provider_id", definition: "TEXT PRIMARY KEY" },
      { name: "base_url", definition: "TEXT" },
      { name: "enabled", definition: "INTEGER NOT NULL DEFAULT 0" },
      { name: "secret_handle", definition: "TEXT" },
      { name: "custom_headers_yaml", definition: "TEXT" },
      { name: "updated_at", definition: "INTEGER NOT NULL" },
    ],
  },
  {
    name: "model_bindings",
    columns: [
      { name: "role", definition: "TEXT PRIMARY KEY" },
      { name: "provider_id", definition: "TEXT NOT NULL" },
      { name: "model_id", definition: "TEXT NOT NULL" },
      { name: "strategy", definition: "TEXT NOT NULL DEFAULT 'fixed'" },
      { name: "fallback_chain_yaml", definition: "TEXT" },
      { name: "updated_at", definition: "INTEGER NOT NULL" },
    ],
  },
  {
    name: "permission_grants",
    columns: [
      { name: "id", definition: "TEXT PRIMARY KEY" },
      { name: "session_id", definition: "TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE" },
      { name: "scope", definition: "TEXT NOT NULL" },
      { name: "tool_id", definition: "TEXT NOT NULL" },
      { name: "decision", definition: "TEXT NOT NULL" },
      { name: "expires_at", definition: "INTEGER" },
      { name: "created_at", definition: "INTEGER NOT NULL" },
    ],
    extras: ["CREATE INDEX IF NOT EXISTS idx_permission_grants_session ON permission_grants(session_id, tool_id)"],
  },
] as const satisfies readonly SqlTableSpec[];

/** 把声明式表结构转换成 CREATE TABLE SQL，迁移生成时复用。 */
export function createTableSql(table: SqlTableSpec): string {
  const columns = table.columns.map((column) => `  ${column.name} ${column.definition}`).join(",\n");
  return `CREATE TABLE IF NOT EXISTS ${table.name} (\n${columns}\n);`;
}
