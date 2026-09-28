-- skills 原来只索引 user, builtin 在首次目录对账后加入同一张表.
ALTER TABLE skills ADD COLUMN scope TEXT NOT NULL DEFAULT 'user'
  CHECK (scope IN ('builtin', 'user'));
ALTER TABLE skills ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1
  CHECK (enabled IN (0, 1));

-- 未索引的路径还没有真实技能元数据, 先保留原开关, 不伪造索引行.
ALTER TABLE skill_enablement RENAME TO skill_enablement_migration;

UPDATE skills
SET enabled = (
  SELECT enabled FROM skill_enablement_migration WHERE skill_path = skills.path
)
WHERE path IN (SELECT skill_path FROM skill_enablement_migration);

DELETE FROM skill_enablement_migration
WHERE skill_path IN (SELECT path FROM skills);

-- 后续由目录对账搬入剩余开关, 全部搬完再删除迁移表. 正常启停只访问 skills.
