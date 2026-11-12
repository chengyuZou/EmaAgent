-- 从旧库升级时先删引用表, 让 SQLite 在外键开启的情况下重建剧情表.
DROP TABLE IF EXISTS keyword_cache;
DROP TABLE IF EXISTS relation_chunks;
DROP TABLE IF EXISTS entity_chunks;
DROP TABLE IF EXISTS relations;
DROP TABLE IF EXISTS entities;
DROP TABLE IF EXISTS chunks;

-- 块保留周目, 图全库共用. 向量为 Pro/bge-m3 的 1024 维 little-endian Float32.
CREATE TABLE chunks (
  chunk_id TEXT NOT NULL PRIMARY KEY,
  timeline_id TEXT NOT NULL CHECK (timeline_id IN ('1st_Loop', '2nd_Loop', '3rd_Loop')),
  content TEXT NOT NULL,
  vector BLOB NOT NULL CHECK (typeof(vector) = 'blob' AND length(vector) = 4096)
);

CREATE INDEX chunks_by_timeline ON chunks (timeline_id);

CREATE TABLE entities (
  entity_name TEXT NOT NULL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  description TEXT NOT NULL,
  vector BLOB NOT NULL CHECK (typeof(vector) = 'blob' AND length(vector) = 4096)
);

-- 端点按 BINARY 文本顺序保存. 同一对端点可以有多条关系, 由 relation_id 区分.
CREATE TABLE relations (
  relation_id INTEGER PRIMARY KEY,
  source_entity TEXT NOT NULL,
  target_entity TEXT NOT NULL,
  description TEXT NOT NULL,
  weight REAL NOT NULL,
  vector BLOB NOT NULL CHECK (typeof(vector) = 'blob' AND length(vector) = 4096),
  CHECK (source_entity <= target_entity COLLATE BINARY),
  FOREIGN KEY (source_entity) REFERENCES entities (entity_name),
  FOREIGN KEY (target_entity) REFERENCES entities (entity_name)
);

CREATE INDEX relations_source ON relations (source_entity);
CREATE INDEX relations_target ON relations (target_entity);

CREATE TABLE entity_chunks (
  entity_name TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  PRIMARY KEY (entity_name, chunk_id),
  FOREIGN KEY (entity_name) REFERENCES entities (entity_name),
  FOREIGN KEY (chunk_id) REFERENCES chunks (chunk_id)
);

CREATE TABLE relation_chunks (
  relation_id INTEGER NOT NULL,
  chunk_id TEXT NOT NULL,
  PRIMARY KEY (relation_id, chunk_id),
  FOREIGN KEY (relation_id) REFERENCES relations (relation_id),
  FOREIGN KEY (chunk_id) REFERENCES chunks (chunk_id)
);
