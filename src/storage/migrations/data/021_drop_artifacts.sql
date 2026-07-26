-- 删除已废弃的 Artifact 产物表。
-- Artifact 功能（文本/代码/Diff 草稿 -> 审阅 -> 应用）已物理删除，
-- 代码文件由 FileWrite/FileEdit + Diff/Review 处理，不再需要该表。
-- 使用 IF EXISTS 兼容已经删除该表的开发数据库。

DROP INDEX IF EXISTS idx_artifacts_session;
DROP INDEX IF EXISTS idx_artifacts_turn;
DROP TABLE IF EXISTS artifacts;
