import type { SqliteDb } from '../database.js';

// ── Raw DB row ────────────────────────────────────────────────────────────────
//
// File-backed model: this row is an INDEX over <dir_path>/SKILL.md. The body is
// NOT stored here — it is read lazily from disk on activation. Frontmatter
// fields are mirrored so the catalog can be built without opening files.

export interface SkillRow {
  id:             string;
  name:           string;
  version:        string;
  description:    string;
  arg_hint:       string | null;   // frontmatter argument-hint
  dir_path:       string;          // absolute path to the skill directory
  source:         string;          // 'builtin' | 'user' | 'market'
  source_url:     string | null;
  sha256:         string | null;
  size_bytes:     number;          // total size of the skill dir (bytes)
  enabled:        number;          // 0 | 1
  content_mtime:  number;          // SKILL.md mtime (ms)
  installed_at:   number;
}

// ── SkillsRepo ────────────────────────────────────────────────────────────────
//
// Pure SQL layer — does NOT import from @ema-agent/skill.
// Schema validation, frontmatter parsing, and filesystem reconciliation live in
// SkillStore. This repo just persists/reads the index.

export class SkillsRepo {
  constructor(private readonly db: SqliteDb) {}

  /**
   * Insert or update by unique `name`. The reconcile scan and the installer both
   * upsert, so a single idempotent entry point avoids insert/update branching
   * at call sites. `enabled` and `installed_at` are preserved on update so a
   * reconcile scan never re-enables a user-disabled skill or resets its age.
   */
  upsertByName(row: SkillRow): void {
    this.db.prepare(`
      INSERT INTO skills
        (id, name, version, description, arg_hint, dir_path, source,
         source_url, sha256, size_bytes, enabled, content_mtime, installed_at)
      VALUES
        (@id, @name, @version, @description, @arg_hint, @dir_path, @source,
         @source_url, @sha256, @size_bytes, @enabled, @content_mtime, @installed_at)
      ON CONFLICT(name) DO UPDATE SET
        version       = excluded.version,
        description   = excluded.description,
        arg_hint      = excluded.arg_hint,
        dir_path      = excluded.dir_path,
        source        = excluded.source,
        source_url    = excluded.source_url,
        sha256        = excluded.sha256,
        size_bytes    = excluded.size_bytes,
        content_mtime = excluded.content_mtime
    `).run(row);
  }

  setEnabled(name: string, enabled: number): void {
    this.db.prepare('UPDATE skills SET enabled = ? WHERE name = ?').run(enabled, name);
  }

  rename(oldName: string, newName: string): void {
    this.db.prepare('UPDATE skills SET name = ? WHERE name = ?').run(newName, oldName);
  }

  setDirPath(name: string, dirPath: string): void {
    this.db.prepare('UPDATE skills SET dir_path = ? WHERE name = ?').run(dirPath, name);
  }

  findById(id: string): SkillRow | null {
    return (this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as SkillRow | undefined) ?? null;
  }

  findByName(name: string): SkillRow | null {
    return (this.db.prepare('SELECT * FROM skills WHERE name = ?').get(name) as SkillRow | undefined) ?? null;
  }

  listAll(): SkillRow[] {
    return this.db.prepare('SELECT * FROM skills ORDER BY installed_at ASC').all() as SkillRow[];
  }

  listEnabled(): SkillRow[] {
    return this.db.prepare('SELECT * FROM skills WHERE enabled = 1 ORDER BY installed_at ASC').all() as SkillRow[];
  }

  deleteByName(name: string): void {
    this.db.prepare('DELETE FROM skills WHERE name = ?').run(name);
  }

  deleteById(id: string): void {
    this.db.prepare('DELETE FROM skills WHERE id = ?').run(id);
  }
}
