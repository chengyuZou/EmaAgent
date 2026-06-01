import type { SqliteDb } from '../database.js';

// ── Raw DB row ────────────────────────────────────────────────────────────────

export interface SkillRow {
  id:             string;
  name:           string;
  version:        string;
  description:    string;
  source_url:     string | null;
  content_md:     string;          // full SKILL.md — parsed by packages/skill
  activates_json: string;          // JSON array: ["chat","agent",...]
  enabled:        number;          // 0 | 1
  installed_at:   number;
}

// ── SkillsRepo ────────────────────────────────────────────────────────────────
//
// Pure SQL layer — does NOT import from @ema-agent/skill.
// Schema validation and frontmatter parsing live in SkillStore.

export class SkillsRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(row: SkillRow): void {
    this.db.prepare(`
      INSERT INTO skills
        (id, name, version, description, source_url, content_md,
         activates_json, enabled, installed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.name, row.version, row.description,
      row.source_url, row.content_md, row.activates_json,
      row.enabled, row.installed_at,
    );
  }

  update(id: string, patch: {
    name?:           string;
    version?:        string;
    description?:    string;
    sourceUrl?:      string | null;
    contentMd?:      string;
    activatesJson?:  string;
    enabled?:        number;
  }): void {
    const cols:   string[] = [];
    const values: unknown[] = [];

    if (patch.name          !== undefined) { cols.push('name = ?');           values.push(patch.name); }
    if (patch.version       !== undefined) { cols.push('version = ?');        values.push(patch.version); }
    if (patch.description   !== undefined) { cols.push('description = ?');    values.push(patch.description); }
    if (patch.sourceUrl     !== undefined) { cols.push('source_url = ?');     values.push(patch.sourceUrl); }
    if (patch.contentMd     !== undefined) { cols.push('content_md = ?');     values.push(patch.contentMd); }
    if (patch.activatesJson !== undefined) { cols.push('activates_json = ?'); values.push(patch.activatesJson); }
    if (patch.enabled       !== undefined) { cols.push('enabled = ?');        values.push(patch.enabled); }

    if (cols.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE skills SET ${cols.join(', ')} WHERE id = ?`).run(...values);
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

  deleteById(id: string): void {
    this.db.prepare('DELETE FROM skills WHERE id = ?').run(id);
  }
}
