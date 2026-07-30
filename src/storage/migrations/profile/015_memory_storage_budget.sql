-- Memory 预算驱逐向量时保留正文，并用明确列区分“主动回收”与“尚未生成”。
-- 后台 embedding repair 只修复未被主动驱逐的行，避免两个维护任务反复争抢配额。

ALTER TABLE memory_nodes ADD COLUMN embedding_evicted_at INTEGER;
ALTER TABLE memory_items ADD COLUMN embedding_evicted_at INTEGER;
