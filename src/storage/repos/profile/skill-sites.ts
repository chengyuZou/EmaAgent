// skill_sites 的 SQL 层:站点实体 + 索引缓存(etag/fetch_status),纯持久化不含业务。
import type { SqliteDb } from '../../database/database.js';

export interface SkillSiteRow {
  id:             string;
  label:          string;
  index_url:      string;
  enabled:        number;          // 0 | 1;市场实体状态,与技能启用无关
  builtin:        number;          // 0 | 1
  sort_order:     number;
  auto_update:    number;          // 0 | 1;默认关,用户自行开启
  created_at:     number;
  index_json:     string | null;   // 上次成功拉取的索引原文
  schema_version: number | null;
  last_fetch_at:  number | null;
  fetch_status:   string;          // 'never' | 'ok' | 'failed'
  last_error:     string | null;
  etag:           string | null;
  last_modified:  string | null;
  updated_at:     number;
}

export type SkillSiteInsert = Pick<
  SkillSiteRow,
  'id' | 'label' | 'index_url' | 'builtin' | 'sort_order' | 'auto_update' | 'created_at' | 'updated_at'
> & { enabled?: number };

export class SkillSitesRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(row: SkillSiteInsert): void {
    this.db.prepare(`
      INSERT INTO skill_sites
        (id, label, index_url, enabled, builtin, sort_order, auto_update, created_at, updated_at)
      VALUES
        (@id, @label, @index_url, @enabled, @builtin, @sort_order, @auto_update, @created_at, @updated_at)
    `).run({ enabled: 1, ...row });
  }

  update(id: string, patch: Partial<Omit<SkillSiteRow, 'id' | 'created_at'>>): void {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return;
    const cols = entries.map(([key]) => `${key} = @${key}`).join(', ');
    this.db.prepare(`UPDATE skill_sites SET ${cols} WHERE id = @__id`)
      .run({ ...Object.fromEntries(entries), __id: id });
  }

  findById(id: string): SkillSiteRow | null {
    return (this.db.prepare('SELECT * FROM skill_sites WHERE id = ?').get(id) as SkillSiteRow | undefined) ?? null;
  }

  listAll(): SkillSiteRow[] {
    return this.db.prepare(
      'SELECT * FROM skill_sites ORDER BY sort_order ASC, created_at ASC',
    ).all() as SkillSiteRow[];
  }

  listEnabled(): SkillSiteRow[] {
    return this.db.prepare(
      'SELECT * FROM skill_sites WHERE enabled = 1 ORDER BY sort_order ASC, created_at ASC',
    ).all() as SkillSiteRow[];
  }

  /** 内置站点不可删。 */
  deleteById(id: string): boolean {
    return this.db.prepare('DELETE FROM skill_sites WHERE id = ? AND builtin = 0').run(id).changes === 1;
  }
}
