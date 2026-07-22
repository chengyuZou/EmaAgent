-- 将旧三模式拆成执行 Profile、Narrative 策略和明确的 Turn 触发来源。
ALTER TABLE sessions ADD COLUMN execution_profile TEXT NOT NULL DEFAULT 'chat'
  CHECK(execution_profile IN ('chat', 'work'));
ALTER TABLE sessions ADD COLUMN narrative_policy TEXT NOT NULL DEFAULT 'auto'
  CHECK(narrative_policy IN ('auto', 'always', 'off'));

UPDATE sessions
SET execution_profile = CASE last_mode
      WHEN 'agent' THEN 'work'
      ELSE 'chat'
    END,
    narrative_policy = CASE last_mode
      WHEN 'narrative' THEN 'always'
      WHEN 'chat' THEN 'off'
      WHEN 'agent' THEN 'off'
      ELSE 'auto'
    END;

ALTER TABLE sessions DROP COLUMN last_mode;
ALTER TABLE sessions DROP COLUMN meta_json;

ALTER TABLE turns ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'userMessage'
  CHECK(trigger_type IN ('userMessage'));
ALTER TABLE turns ADD COLUMN execution_profile TEXT NOT NULL DEFAULT 'chat'
  CHECK(execution_profile IN ('chat', 'work'));
ALTER TABLE turns ADD COLUMN narrative_policy TEXT NOT NULL DEFAULT 'auto'
  CHECK(narrative_policy IN ('auto', 'always', 'off'));

UPDATE turns
SET execution_profile = CASE mode
      WHEN 'agent' THEN 'work'
      ELSE 'chat'
    END,
    narrative_policy = CASE mode
      WHEN 'narrative' THEN 'always'
      WHEN 'chat' THEN 'off'
      WHEN 'agent' THEN 'off'
      ELSE 'auto'
    END;

ALTER TABLE turns DROP COLUMN mode;
ALTER TABLE turns DROP COLUMN meta_json;
