ALTER TABLE memory_jobs
  ADD COLUMN reminder_ignored INTEGER NOT NULL DEFAULT 0
  CHECK (reminder_ignored IN (0, 1));

CREATE INDEX idx_memory_jobs_created ON memory_jobs(created_at, id);
CREATE INDEX idx_memory_jobs_unignored_failures ON memory_jobs(created_at, id)
  WHERE status = 'failed' AND reminder_ignored = 0;
