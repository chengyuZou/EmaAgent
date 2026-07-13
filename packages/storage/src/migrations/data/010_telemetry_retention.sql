-- 010: 支持按全局时间有界清理 telemetry_events。
--
-- idx_telemetry_kind 的首列是 kind，只适合按事件类型查询，不能高效支持
-- 不区分 kind 的全局保留策略。独立索引同时覆盖过期过滤、确定性排序和 id 删除。

CREATE INDEX idx_telemetry_retention
  ON telemetry_events(created_at ASC, id ASC);
