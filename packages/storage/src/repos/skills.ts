// 这里持久化文件型 Skill 的可重建 SQL 索引.
import type { SqliteDb } from '../database.js';

// ── 原始 DB 行 ────────────────────────────────────────────────────────────────
//
// 文件驱动模型:此行是 <dir_path>/SKILL.md 的索引。body 不存这里,
// 激活时才从磁盘懒读。Frontmatter 字段镜像存储,以便构建 catalog 时无需打开文件。

export interface SkillRow {
  id:             string;
  name:           string;
  version:        string;
  description:    string;
  arg_hint:       string | null;   // frontmatter 的 argument-hint
  dir_path:       string;          // skill 目录的绝对路径
  source:         string;          // 'builtin' | 'user' | 'market'
  source_url:     string | null;
  sha256:         string | null;
  size_bytes:     number;          // skill 目录总大小(字节)
  enabled:        number;          // 0 | 1
  content_mtime:  number;          // SKILL.md 的 mtime(毫秒)
  installed_at:   number;
}

// ── SkillsRepo ────────────────────────────────────────────────────────────────
//
// 纯 SQL 层,不 import @ema-agent/skill。
// 结构校验、frontmatter 解析、文件系统对账都在 SkillStore 里。
// 本 repo 只负责持久化/读取索引。

export class SkillsRepo {
  constructor(private readonly db: SqliteDb) {}

  /**
   * 按唯一 `name` 插入或更新。reconcile 扫描和 installer 都走 upsert,
   * 单一幂等入口避免调用方区分 insert/update 分支。更新时保留 `enabled` 和
   * `installed_at`,确保 reconcile 扫描不会重新启用用户禁用的 skill 或重置其 age。
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

  /** 在一个 SQL UPDATE 中同步修改名称, 路径和 manifest 索引字段. */
  replaceByName(oldName: string, row: SkillRow): void {
    const result = this.db.prepare(`
      UPDATE skills SET
        name          = @name,
        version       = @version,
        description   = @description,
        arg_hint      = @arg_hint,
        dir_path      = @dir_path,
        source        = @source,
        source_url    = @source_url,
        sha256        = @sha256,
        size_bytes    = @size_bytes,
        enabled       = @enabled,
        content_mtime = @content_mtime,
        installed_at  = @installed_at
      WHERE name = @old_name
    `).run({ ...row, old_name: oldName });
    if (result.changes !== 1) throw new Error(`Skill index row not found: ${oldName}`);
  }

  setEnabled(name: string, enabled: number): void {
    this.db.prepare('UPDATE skills SET enabled = ? WHERE name = ?').run(enabled, name);
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
