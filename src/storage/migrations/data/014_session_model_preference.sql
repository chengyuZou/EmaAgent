-- Session 显式保存用户下一轮想使用的供应商配置和模型，供模型选择器恢复状态。
ALTER TABLE sessions ADD COLUMN preferred_provider_config_id TEXT;
ALTER TABLE sessions ADD COLUMN preferred_model_id TEXT;

-- 两列描述同一个模型选择，禁止只写入其中一半形成无法解释的 Session 状态。
CREATE TRIGGER sessions_preferred_model_pair_insert
BEFORE INSERT ON sessions
WHEN (NEW.preferred_provider_config_id IS NULL) <> (NEW.preferred_model_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'session preferred model must contain both provider and model');
END;

CREATE TRIGGER sessions_preferred_model_pair_update
BEFORE UPDATE OF preferred_provider_config_id, preferred_model_id ON sessions
WHEN (NEW.preferred_provider_config_id IS NULL) <> (NEW.preferred_model_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'session preferred model must contain both provider and model');
END;
