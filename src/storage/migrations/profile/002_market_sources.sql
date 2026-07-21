-- 002: market_sources 表(多源市场聚合底座,MCP/Skill/未来 integration 共用)
--
-- 历史问题:market_sources 最初直接加进 001_initial.sql,但对 user_version=1 的
-- 旧 DB,迁移 runner 不会重跑 001(migrations.ts:for v=current+1..latest,001 已跑过
-- 跳过),导致旧 DB 永远没有这张表 → sidecar 启动 seed 失败:
--   SqliteError: no such table: market_sources
-- 所有 /api/market/* 路由炸。修法:加 002 增量迁移补建表。
--
-- 用 IF NOT EXISTS 幂等:新装 DB 跑 001 已建此表,002 跳过;旧 DB 跑 002 补建。
-- 表结构跟 001 里的定义完全一致(复制自 001,只是改 CREATE TABLE → CREATE TABLE IF NOT EXISTS)。

CREATE TABLE IF NOT EXISTS market_sources (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  type        TEXT NOT NULL,
  label       TEXT NOT NULL,
  config      TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  builtin     INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_market_sources_kind ON market_sources(kind);
