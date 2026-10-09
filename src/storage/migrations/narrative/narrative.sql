-- 固定三周目共用一库. 向量为 Pro/bge-m3 的 1024 维 little-endian Float32.
CREATE TABLE chunks (
  timeline_id TEXT NOT NULL CHECK (timeline_id IN ('1st_Loop', '2nd_Loop', '3rd_Loop')),
  chunk_id TEXT NOT NULL,
  content TEXT NOT NULL,
  vector BLOB NOT NULL CHECK (typeof(vector) = 'blob' AND length(vector) = 4096),
  PRIMARY KEY (timeline_id, chunk_id)
);

CREATE TABLE entities (
  timeline_id TEXT NOT NULL CHECK (timeline_id IN ('1st_Loop', '2nd_Loop', '3rd_Loop')),
  entity_name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  description TEXT NOT NULL,
  vector BLOB NOT NULL CHECK (typeof(vector) = 'blob' AND length(vector) = 4096),
  PRIMARY KEY (timeline_id, entity_name)
);

-- 无向关系的端点按 BINARY 文本顺序保存, 两端必须属于同一周目.
CREATE TABLE relations (
  timeline_id TEXT NOT NULL,
  relation_id INTEGER NOT NULL,
  source_entity TEXT NOT NULL,
  target_entity TEXT NOT NULL,
  description TEXT NOT NULL,
  weight REAL NOT NULL,
  vector BLOB NOT NULL CHECK (typeof(vector) = 'blob' AND length(vector) = 4096),
  PRIMARY KEY (timeline_id, relation_id),
  UNIQUE (timeline_id, source_entity, target_entity),
  CHECK (source_entity <= target_entity COLLATE BINARY),
  FOREIGN KEY (timeline_id, source_entity) REFERENCES entities (timeline_id, entity_name),
  FOREIGN KEY (timeline_id, target_entity) REFERENCES entities (timeline_id, entity_name)
);

-- UNIQUE 索引覆盖 source_entity 邻接读取, 此索引覆盖无向关系的另一端.
CREATE INDEX relations_target ON relations (timeline_id, target_entity);

CREATE TABLE entity_chunks (
  timeline_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  PRIMARY KEY (timeline_id, entity_name, chunk_id),
  FOREIGN KEY (timeline_id, entity_name) REFERENCES entities (timeline_id, entity_name),
  FOREIGN KEY (timeline_id, chunk_id) REFERENCES chunks (timeline_id, chunk_id)
);

CREATE TABLE relation_chunks (
  timeline_id TEXT NOT NULL,
  relation_id INTEGER NOT NULL,
  chunk_id TEXT NOT NULL,
  PRIMARY KEY (timeline_id, relation_id, chunk_id),
  FOREIGN KEY (timeline_id, relation_id) REFERENCES relations (timeline_id, relation_id),
  FOREIGN KEY (timeline_id, chunk_id) REFERENCES chunks (timeline_id, chunk_id)
);
