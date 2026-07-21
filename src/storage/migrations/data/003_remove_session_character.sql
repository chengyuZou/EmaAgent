-- Session 只表示对话与 Agent 回合容器，不绑定角色卡。
-- 角色选择属于独立的角色运行时状态，同一 Session 内允许自由切换。
ALTER TABLE sessions DROP COLUMN character_card_id;
