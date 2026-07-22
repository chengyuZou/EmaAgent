-- Memory 只按 Chat/Work 执行范围组织长期记忆；Narrative RAG 不再形成记忆分区。
UPDATE memory_items
SET modes_json = (
  SELECT json_group_array(profile)
  FROM (
    SELECT DISTINCT
      CASE value
        WHEN 'agent' THEN 'work'
        WHEN 'narrative' THEN 'chat'
        ELSE value
      END AS profile
    FROM json_each(memory_items.modes_json)
    WHERE value IN ('chat', 'work', 'agent', 'narrative')
  )
);

ALTER TABLE memory_items RENAME COLUMN modes_json TO profiles_json;
