-- ── Branch table ──────────────────────────────────────────────────────────────
--
-- Tracks message-level fork branches within a single session.
--
-- Root branch:  parent_branch_id IS NULL, fork_from_turn_id IS NULL.
-- Child branch: parent_branch_id = parent's id,
--               fork_from_turn_id = last turn on parent before divergence.
--
-- sessions.active_branch_id: currently-viewed branch.
--   NULL  → no branching has occurred; all turns have branch_id = NULL.
--   set   → at least one fork happened; use branch-aware message loading.
--
-- turns.branch_id: which branch this turn belongs to.
--   NULL  → pre-fork turn; backfilled to the root branch_id at first fork.

CREATE TABLE branches (
  id                TEXT    PRIMARY KEY,
  session_id        TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_branch_id  TEXT    REFERENCES branches(id),
  fork_from_turn_id TEXT    REFERENCES turns(id),
  created_at        INTEGER NOT NULL
);

CREATE INDEX idx_branches_session   ON branches(session_id);
CREATE INDEX idx_branches_fork_turn ON branches(fork_from_turn_id);

ALTER TABLE sessions ADD COLUMN active_branch_id TEXT REFERENCES branches(id);
ALTER TABLE turns    ADD COLUMN branch_id        TEXT REFERENCES branches(id);

CREATE INDEX idx_turns_branch ON turns(branch_id);
