-- B-058：model_bindings 的 module CHECK 从 17 收紧到 11。
-- V0.4 的 chat/narrative/agent/compaction/embed/rerank 已 retired：chat/narrative/agent
-- 的模型改在 chat UI 里按 turn 选，compaction 复用 turn 的模型，embed/rerank 移到了
-- app settings (kb.models)。TS 侧 BindingModule 早已只保留 11 个，但 001 的 SQL CHECK
-- 仍宽松允许 17 个，导致 DB 层与 TS 类型漂移。本迁移清理 retired 模块的残留绑定行，
-- 并重建表把 CHECK 收紧到与 TS 一致的 11 个。
-- SQLite 不支持 ALTER 修改 CHECK 约束，必须重建表。

-- 1. 清理 retired 模块的残留绑定（TS 侧已不使用，安全删除）
DELETE FROM model_bindings WHERE module IN (
  'chat', 'narrative', 'agent', 'compaction', 'embed', 'rerank'
);

-- 2. 重建表，CHECK 收紧到 11 个（与 BindingModule union 一致）
CREATE TABLE model_bindings_new (
  module             TEXT    NOT NULL
                     CHECK(module IN (
                       'emotion', 'memory',
                       'router', 'plan-parse', 'title',
                       'lightrag-embed', 'lightrag-llm',
                       'tts',
                       'stt', 'vision', 'imagegen'
                     )),
  provider_config_id TEXT    NOT NULL REFERENCES provider_configs(id) ON DELETE RESTRICT,
  model              TEXT    NOT NULL,
  voice_id           TEXT,
  config_json        TEXT    NOT NULL DEFAULT '{}',
  PRIMARY KEY (module, provider_config_id, model)
);

-- 3. 迁移存量数据（retired 行已清，剩余均为合法 11 模块）
INSERT INTO model_bindings_new (module, provider_config_id, model, voice_id, config_json)
  SELECT module, provider_config_id, model, voice_id, config_json FROM model_bindings;

-- 4. 替换旧表（model_bindings 无被引用的外键，重建安全）
DROP TABLE model_bindings;
ALTER TABLE model_bindings_new RENAME TO model_bindings;
