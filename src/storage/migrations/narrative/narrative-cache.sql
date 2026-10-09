-- 只缓存查询提词, 不导入抽取/摘要回执, 不保存模型生成的最终回答.
CREATE TABLE keyword_cache (
  -- LightRAG 的 mode:keywords:args_hash, args_hash 由模式, 问题和语言生成.
  cache_key TEXT NOT NULL PRIMARY KEY,
  high_level_keywords TEXT NOT NULL CHECK (json_valid(high_level_keywords) AND json_type(high_level_keywords) = 'array'),
  low_level_keywords TEXT NOT NULL CHECK (json_valid(low_level_keywords) AND json_type(low_level_keywords) = 'array')
);
