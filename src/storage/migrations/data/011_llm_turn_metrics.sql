-- 011: turn_usage 实际承载 Token、成本、模型归因和耗时，重命名为明确的
-- LLM Turn 指标表。ALTER TABLE 原位保留历史数据、主键和 Turn 级联外键。

ALTER TABLE turn_usage RENAME TO llm_turn_metrics;
