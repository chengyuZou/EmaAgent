import type { SqliteDb } from '../../database/database.js';

export interface SkillRow {
  path:           string;
  scope:          'builtin' | 'user';
  enabled:        number;
  name:           string;
  /** SKILL.md frontmatter version, 只作展示. */
  version:        string | null;
  description:    string;
  dir_path:       string;
  size_bytes:     number;
  installed_at:   number;
}

// SQL 只保存 builtin/user 的索引与启停, 目录解析和文件操作由 Skills 负责.

export class SkillsRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 更新目录事实时保留 enabled 和 installed_at, 重扫不能覆盖用户选择. */
  upsert(row: SkillRow): void {
    this.db.prepare(`
      INSERT INTO skills
        (path, scope, enabled, name, version, description, dir_path, size_bytes, installed_at)
      VALUES
        (@path, @scope, @enabled, @name, @version, @description, @dir_path, @size_bytes, @installed_at)
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

  listByScope(scope: SkillRow['scope']): SkillRow[] {
    return this.db.prepare(
      'SELECT * FROM skills WHERE scope = ? ORDER BY installed_at ASC, path ASC',
    ).all(scope) as SkillRow[];
  }

  setEnabled(path: string, enabled: number): void {
    this.db.prepare('UPDATE skills SET enabled = ? WHERE path = ?').run(enabled, path);
  }

  listDisabledPaths(): string[] {
    const rows = this.db.prepare(
      'SELECT path FROM skills WHERE enabled = 0 ORDER BY path ASC',
    ).all() as { path: string }[];
    return rows.map(row => row.path);
  }

  deleteByPath(path: string): void {
    this.db.prepare('DELETE FROM skills WHERE path = ?').run(path);
  }
}
