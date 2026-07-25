-- 012: permission_rules 表(用户永久权限规则,存 profile.db)
--
-- V1 支持"始终允许此工作区"写入此表;全局规则 scope=global,工作区规则 scope=workspace。
-- session 级临时授权不存此表,由 PermissionEngine 内存 SessionGrantStore 管理。
-- 内置安全规则由代码提供,不写入用户规则表。
--
-- 旧 data.db.permission_grants(effect/scope session|persistent/source)字段与当前
-- PermissionRule 不一致,且无 Repo 和生产调用方,由 data/020 删除。

CREATE TABLE IF NOT EXISTS permission_rules (
  id             TEXT PRIMARY KEY,
  action         TEXT NOT NULL
                 CHECK(action IN ('allow', 'deny', 'ask')),
  tool_id        TEXT NOT NULL,
  path_glob      TEXT,
  scope          TEXT NOT NULL
                 CHECK(scope IN ('global', 'workspace')),
  workspace_root TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1
                 CHECK(enabled IN (0, 1)),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,

  CHECK(
    (scope = 'global' AND workspace_root IS NULL)
    OR
    (scope = 'workspace' AND workspace_root IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_permission_rules_selector
ON permission_rules(
  scope,
  IFNULL(workspace_root, ''),
  tool_id,
  IFNULL(path_glob, '')
);

CREATE INDEX IF NOT EXISTS idx_permission_rules_enabled
ON permission_rules(enabled, scope, tool_id);
