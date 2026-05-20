-- ── Migration 006: memory subsystem ──────────────────────────────────────────
--
-- Adds the durable storage for the three-layer companion memory model + the
-- agent long-term memory schema. Companion uses Layer 0 (entity graph) +
-- Layer 1 (session notes) + Layer 2 (mode-weighted memory_items). Agent reuses
-- memory_items with 4 kinds and skips Layer 2 weighting.
--
-- New tables:
--   memory_nodes              — Layer 0 entity graph nodes (cross-session, all modes)
--   memory_edges              — Layer 0 entity graph edges (mention_count for weight)
--   memory_node_lazy_updates  — append-only buffer for batched consolidation
--   session_notes             — Layer 1 mode-specific session summary (one row per session)
--   background_tasks          — durable queue for extraction/consolidation/compaction work
--
-- Existing tables touched:
--   memory_items              — modes_json + last_referenced_at + embedding provenance
--   sessions                  — pending_fragments_json (Layer-2 extraction inbox)
--   model_bindings            — 'memory' module added to CHECK constraint

-- ── memory_nodes ─────────────────────────────────────────────────────────────

CREATE TABLE memory_nodes (
  id                     TEXT PRIMARY KEY,
  label                  TEXT NOT NULL,
  node_type              TEXT NOT NULL CHECK(node_type IN (
                           'user_fact', 'entity', 'event',
                           'emotion', 'preference', 'relationship'
                         )),
  description            TEXT NOT NULL,
  embedding              BLOB,
  embedding_provider_id  TEXT,
  embedding_model        TEXT,
  embedding_dim          INTEGER,
  importance             INTEGER NOT NULL DEFAULT 50
                         CHECK(importance BETWEEN 0 AND 100),
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  last_referenced_at     INTEGER NOT NULL,
  meta_json              TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX idx_memory_nodes_label_type ON memory_nodes(label, node_type);
CREATE INDEX        idx_memory_nodes_type       ON memory_nodes(node_type);
CREATE INDEX        idx_memory_nodes_lastref    ON memory_nodes(last_referenced_at DESC);
CREATE INDEX        idx_memory_nodes_importance ON memory_nodes(importance DESC);

-- ── memory_edges ─────────────────────────────────────────────────────────────

CREATE TABLE memory_edges (
  id                  TEXT PRIMARY KEY,
  from_node_id        TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  to_node_id          TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  relation            TEXT NOT NULL,
  mention_count       INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  last_referenced_at  INTEGER NOT NULL,
  UNIQUE(from_node_id, to_node_id, relation)
);
CREATE INDEX idx_memory_edges_from ON memory_edges(from_node_id);
CREATE INDEX idx_memory_edges_to   ON memory_edges(to_node_id);

-- ── memory_node_lazy_updates ─────────────────────────────────────────────────
-- Append-only buffer: each session's extraction appends pending fragments
-- against existing nodes; consolidation drains them by primary key.
-- INSERT is atomic per row, so concurrent sessions are safe.

CREATE TABLE memory_node_lazy_updates (
  id                 TEXT PRIMARY KEY,
  node_id            TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  fragment           TEXT NOT NULL,
  source_session_id  TEXT,
  source_turn_id     TEXT,
  created_at         INTEGER NOT NULL
);
CREATE INDEX idx_lazy_updates_node ON memory_node_lazy_updates(node_id, created_at);

-- ── memory_items: extend with mode tags + embedding provenance ───────────────

ALTER TABLE memory_items ADD COLUMN modes_json            TEXT NOT NULL DEFAULT '["chat","agent"]';
ALTER TABLE memory_items ADD COLUMN last_referenced_at    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_items ADD COLUMN embedding_provider_id TEXT;
ALTER TABLE memory_items ADD COLUMN embedding_model       TEXT;
ALTER TABLE memory_items ADD COLUMN embedding_dim         INTEGER;
CREATE INDEX idx_memory_items_lastref ON memory_items(last_referenced_at DESC);

-- ── session_notes ────────────────────────────────────────────────────────────
-- One row per session. body is mode-specific markdown maintained by the
-- background extraction pipeline. last_message_id tracks how far the summary
-- covers, so the next extraction is incremental.

CREATE TABLE session_notes (
  session_id             TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  body                   TEXT NOT NULL DEFAULT '',
  last_message_id        TEXT,
  tokens_at_last_update  INTEGER NOT NULL DEFAULT 0,
  updated_at             INTEGER NOT NULL
);

-- ── sessions: add pending_fragments_json buffer ──────────────────────────────
-- Lazy-updated by the afterMessage hook every turn (pure text append).
-- Drained by extraction when the trigger fires (token count or turn count).

ALTER TABLE sessions ADD COLUMN pending_fragments_json TEXT NOT NULL DEFAULT '[]';

-- ── background_tasks ─────────────────────────────────────────────────────────
-- Durable queue for fire-and-forget work. Process crash recovery: at startup,
-- any task left in 'running' is reset to 'pending' so the worker can pick it
-- up again. 'attempts' is bumped on each retry; > 3 marks the task 'failed'.

CREATE TABLE background_tasks (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK(kind IN (
                  'extraction', 'consolidation', 'compaction',
                  'embedding_refresh'
                )),
  status        TEXT NOT NULL CHECK(status IN (
                  'pending', 'running', 'completed', 'failed'
                )),
  session_id    TEXT,
  payload_json  TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_bgtasks_status_created ON background_tasks(status, created_at);
CREATE INDEX idx_bgtasks_session        ON background_tasks(session_id);

-- ── model_bindings: add 'memory' module to CHECK ─────────────────────────────
-- Rebuild table because SQLite cannot ALTER a CHECK constraint in place.
-- 'memory' powers the extraction + consolidation + compaction LLM calls; this
-- is intentionally a single binding so a small/cheap model can serve all three.

CREATE TABLE model_bindings_v6 (
  module             TEXT    PRIMARY KEY
                     CHECK(module IN (
                       -- TS-side LLM modules
                       'chat', 'narrative', 'agent',
                       'compaction', 'emotion', 'memory',
                       'router', 'plan-parse', 'title',
                       -- LightRAG internal config (Python bridge)
                       'embed', 'rerank', 'lightrag-llm',
                       -- Future TS-side clients
                       'tts', 'stt', 'vision', 'imagegen'
                     )),
  provider_config_id TEXT    NOT NULL REFERENCES provider_configs(id) ON DELETE RESTRICT,
  model              TEXT    NOT NULL,
  voice_id           TEXT,
  config_json        TEXT    NOT NULL DEFAULT '{}'
);

INSERT INTO model_bindings_v6 SELECT * FROM model_bindings;

DROP TABLE  model_bindings;
ALTER TABLE model_bindings_v6 RENAME TO model_bindings;
