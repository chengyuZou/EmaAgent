// 这里持久化文件型 Skill 的可重建 SQL 索引与溯源。
// 目录是事实源:本表只回答"这个目录是什么、从哪装的",启用状态不在这里(Settings deny-list)。
import type { SqliteDb } from '../../database/database.js';

// ── 原始 DB 行 ────────────────────────────────────────────────────────────────

export interface SkillRow {
  /** 稳定 id:手动放置 = 路径哈希;站点安装 = site_<siteId>_<entryId>。 */
  id:             string;
  name:           string;
  /** 站点索引版本(安装/更新对账事实源);SKILL.md frontmatter version 只展示。 */
  version:        string;
  description:    string;
  arg_hint:       string | null;
  dir_path:       string;
  source:         string;          // 'builtin' | 'user' | 'project'
  source_url:     string | null;
  sha256:         string | null;   // bundleSha256
  site_id:        string | null;
  site_entry_id:  string | null;
  size_bytes:     number;
  content_mtime:  number;
  installed_at:   number;
}

// ── SkillsRepo ────────────────────────────────────────────────────────────────
//
// 纯 SQL 层,不 import @ema-agent/skills。
// 结构校验、frontmatter 解析、文件系统对账都在 SkillStore 里。

export class SkillsRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 按稳定 id 幂等写入;更新时保留 installed_at(对账不应重置安装时间)。 */
  upsertById(row: SkillRow): void {
    this.db.prepare(`
      INSERT INTO skills
        (id, name, version, description, arg_hint, dir_path, source,
         source_url, sha256, site_id, site_entry_id, size_bytes, content_mtime, installed_at)
      VALUES
        (@id, @name, @version, @description, @arg_hint, @dir_path, @source,
         @source_url, @sha256, @site_id, @site_entry_id, @size_bytes, @content_mtime, @installed_at)
      ON CONFLICT(id) DO UPDATE SET
        name          = excluded.name,
        version       = excluded.version,
        description   = excluded.description,
        arg_hint      = excluded.arg_hint,
        dir_path      = excluded.dir_path,
        source        = excluded.source,
        source_url    = excluded.source_url,
        sha256        = excluded.sha256,
        site_id       = excluded.site_id,
        site_entry_id = excluded.site_entry_id,
        size_bytes    = excluded.size_bytes,
        content_mtime = excluded.content_mtime
    `).run(row);
  }

  findById(id: string): SkillRow | null {
    return (this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as SkillRow | undefined) ?? null;
  }

  listAll(): SkillRow[] {
    return this.db.prepare('SELECT * FROM skills ORDER BY installed_at ASC').all() as SkillRow[];
  }

  /** 站点更新对账:按 (site_id, site_entry_id) 找已装技能。 */
  listBySite(siteId: string): SkillRow[] {
    return this.db.prepare(
      'SELECT * FROM skills WHERE site_id = ? ORDER BY installed_at ASC',
    ).all(siteId) as SkillRow[];
  }

  deleteById(id: string): void {
    this.db.prepare('DELETE FROM skills WHERE id = ?').run(id);
  }
}
