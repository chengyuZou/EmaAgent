-- Persist the user's last-selected mode per session so ChatInput can restore
-- it on session switch and app restart.
ALTER TABLE sessions ADD COLUMN last_mode     TEXT;
ALTER TABLE sessions ADD COLUMN last_sub_mode TEXT;
