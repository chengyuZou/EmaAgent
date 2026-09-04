import type { SqliteDb } from '../../database/database.js';

// ── 原始 DB 行 ────────────────────────────────────────────────────────────────

export interface SkillRow {
  path:           string;
  name:           string;
  /** SKILL.md frontmatter version,只作展示。 */
  version:        string;
  description:    string;
  dir_path:       string;
  size_bytes:     number;
  installed_at:   number;
}

// ── SkillsRepo ────────────────────────────────────────────────────────────────
//
// 纯 SQL 层,不 import @ema-agent/skills。
// 结构校验、frontmatter 解析、文件系统对账都在 sources/user.ts 里。

export class SkillsRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 按绝对 path 幂等写入;更新时保留 installed_at(对账不应重置安装时间)。 */
  upsert(row: SkillRow): void {
    this.db.prepare(`
      INSERT INTO skills
        (path, name, version, description, dir_path, size_bytes, installed_at)
      VALUES
        (@path, @name, @version, @description, @dir_path, @size_bytes, @installed_at)
      ON CONFLICT(path) DO UPDATE SET
        name          = excluded.name,
        version       = excluded.version,
        description   = excluded.description,
        dir_path      = excluded.dir_path,
        size_bytes    = excluded.size_bytes
    `).run(row);
  }

  findByPath(path: string): SkillRow | null {
    return (this.db.prepare('SELECT * FROM skills WHERE path = ?').get(path) as SkillRow | undefined) ?? null;
  }

  listAll(): SkillRow[] {
    return this.db.prepare('SELECT * FROM skills ORDER BY installed_at ASC').all() as SkillRow[];
  }

  deleteByPath(path: string): void {
    this.db.prepare('DELETE FROM skills WHERE path = ?').run(path);
  }
}
