-- 020: 删除旧的 permission_grants 表
--
-- 旧表在 data.db(会话数据),字段(effect allow|ask|forbidden / scope session|persistent /
-- source user|project|default)与当前 PermissionRule(action allow|deny|ask /
-- scope global|workspace)不一致,且没有 Repo 和生产调用方。
-- 永久规则改存 profile.db.permission_rules(见 profile/012);
-- 会话级临时授权由 PermissionEngine 内存 SessionGrantStore 管理,不需要持久化表。

DROP INDEX IF EXISTS idx_grants_tool;
DROP TABLE IF EXISTS permission_grants;
