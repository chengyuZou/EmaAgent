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

  /** 004 的一次性数据搬运, 等 Skills 建立真实索引后才消费旧开关. */
  migrateEnablement(): void {
    const pending = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'skill_enablement_migration'",
    ).get();
    if (!pending) return;

    this.db.transaction(() => {
      this.db.exec(`
        UPDATE skills
        SET enabled = (
          SELECT enabled FROM skill_enablement_migration WHERE skill_path = skills.path
        )
        WHERE path IN (SELECT skill_path FROM skill_enablement_migration);

        DELETE FROM skill_enablement_migration
        WHERE skill_path IN (SELECT path FROM skills);
      `);
      const remaining = this.db.prepare(
        'SELECT COUNT(*) FROM skill_enablement_migration',
      ).pluck().get() as number;
      // 无法解析或暂时缺失的目录仍保留待搬记录, 修复后重扫继续搬运.
      if (remaining === 0) this.db.exec('DROP TABLE skill_enablement_migration');
    })();
  }

  deleteByPath(path: string): void {
    this.db.prepare('DELETE FROM skills WHERE path = ?').run(path);
  }
}
