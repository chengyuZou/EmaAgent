import type { SqliteDb } from '../database.js';

export interface KbRecordRow {
  id:         string;
  name:       string;
  path:       string;
  is_active:  number;
  created_at: number;
  updated_at: number;
}

export interface KbRecord {
  id:        string;
  name:      string;
  path:      string;
  isActive:  boolean;
  createdAt: number;
  updatedAt: number;
}

function rowToKb(r: KbRecordRow): KbRecord {
  return {
    id:        r.id,
    name:      r.name,
    path:      r.path,
    isActive:  r.is_active === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * 命名知识库的注册表（profile.db）。每个 KB 的文档/向量
 * 存在其 `path` 下的独立 kb.db 中；此表仅作索引 + 标记哪个
 * 处于活跃。镜像 dataDir 注册表的单活跃语义，由
 * partial unique index `idx_kb_active` 强制约束。
 */
export class KbRegistryRepo {
  constructor(private readonly db: SqliteDb) {}

  list(): KbRecord[] {
    return (this.db.prepare('SELECT * FROM knowledge_bases ORDER BY created_at').all() as KbRecordRow[]).map(rowToKb);
  }

  get(id: string): KbRecord | undefined {
    const r = this.db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(id) as KbRecordRow | undefined;
    return r ? rowToKb(r) : undefined;
  }

  getActive(): KbRecord | undefined {
    const r = this.db.prepare('SELECT * FROM knowledge_bases WHERE is_active = 1 LIMIT 1').get() as KbRecordRow | undefined;
    return r ? rowToKb(r) : undefined;
  }

  findByName(name: string): KbRecord | undefined {
    const r = this.db.prepare('SELECT * FROM knowledge_bases WHERE name = ?').get(name) as KbRecordRow | undefined;
    return r ? rowToKb(r) : undefined;
  }

  findByPath(p: string): KbRecord | undefined {
    const r = this.db.prepare('SELECT * FROM knowledge_bases WHERE path = ?').get(p) as KbRecordRow | undefined;
    return r ? rowToKb(r) : undefined;
  }

  /** 插入 KB（非活跃）。调用 setActive() 将其设为活跃。 */
  insert(kb: { id: string; name: string; path: string }): void {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO knowledge_bases (id, name, path, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`,
    ).run(kb.id, kb.name, kb.path, now, now);
  }

  /** 单活跃：清除所有 is_active，再设置当前项。 */
  setActive(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE knowledge_bases SET is_active = 0, updated_at = ? WHERE is_active = 1').run(Date.now());
      this.db.prepare('UPDATE knowledge_bases SET is_active = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
    })();
  }

  rename(id: string, name: string): void {
    this.db.prepare('UPDATE knowledge_bases SET name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM knowledge_bases WHERE id = ?').run(id);
  }
}
