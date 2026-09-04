import type { SqliteDb } from '../../database/database.js';

export class SkillEnablementRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 当前被禁用的 SKILL.md 绝对路径列表;无行 = 默认启用。 */
  listDisabledPaths(): string[] {
    return (
      this.db.prepare('SELECT skill_path FROM skill_enablement WHERE enabled = 0').all() as { skill_path: string }[]
    ).map(row => row.skill_path);
  }

  setEnabled(skillPath: string, enabled: boolean): void {
    this.db.prepare(`
      INSERT INTO skill_enablement (skill_path, enabled) VALUES (@skillPath, @enabled)
      ON CONFLICT(skill_path) DO UPDATE SET enabled = excluded.enabled
    `).run({ skillPath, enabled: enabled ? 1 : 0 });
  }

  /** 技能删除时连带清掉启停行,避免同名技能再放回时幽灵复活为禁用。 */
  deleteByPath(skillPath: string): void {
    this.db.prepare('DELETE FROM skill_enablement WHERE skill_path = ?').run(skillPath);
  }
}
