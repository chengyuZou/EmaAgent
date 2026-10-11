INSERT OR IGNORE INTO settings (key, value_json, updated_at)
SELECT 'agent.limits.maxIterations', value_json, updated_at
FROM settings
WHERE key = 'agent.limits.workMaxIterations';

DELETE FROM settings
WHERE key IN ('agent.limits.chatMaxIterations', 'agent.limits.workMaxIterations');
