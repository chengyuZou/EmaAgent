-- 只扩展权限列的约束, 保留已有值和所有 Session 关联数据.
-- 临时列在同一迁移事务内搬完即删, 不重建被其它表引用的 sessions.
ALTER TABLE sessions RENAME COLUMN permission_mode TO previous_permission_mode;

ALTER TABLE sessions ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'default'
  CHECK(permission_mode IN ('default', 'acceptEdits', 'bypassPermissions', 'plan'));

UPDATE sessions SET permission_mode = previous_permission_mode;

ALTER TABLE sessions DROP COLUMN previous_permission_mode;
