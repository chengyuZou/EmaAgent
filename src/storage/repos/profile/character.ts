import type { SqliteDb } from '../../database/database.js';

export type ProtectedDeleteResult =
  | 'deleted'
  | 'not_found'
  | 'builtin_protected';

export interface CharacterRow {
  id: string;
  name: string;
  description: string | null;
  directory_name: string;
  is_active: number;
  is_builtin: number;
  created_at: number;
  updated_at: number;
}

export interface CharacterInsert {
  id: string;
  name: string;
  description?: string | null;
  /** 创建时确定、此后不可修改的磁盘目录名。 */
  directoryName: string;
  isActive?: boolean;
  isBuiltin?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 普通编辑允许修改的字段；激活状态、内置标记和目录名由专用流程管理。 */
export interface CharacterUpdate {
  name?: string;
  description?: string | null;
  updatedAt?: number;
}

export class CharacterUpdateContractError extends Error {
  readonly code = 'storage/character-reserved-field';

  constructor(readonly field: 'isActive' | 'isBuiltin' | 'directoryName') {
    super(
      field === 'isActive'
        ? 'Character active state must be changed through activate()'
        : field === 'isBuiltin'
          ? 'Character builtin state is immutable after insertion'
          : 'Character directory name is immutable after creation',
    );
    this.name = 'CharacterUpdateContractError';
  }
}

export class CharacterRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(c: CharacterInsert): void {
    this.db
      .prepare(
        `INSERT INTO characters
           (id, name, description, directory_name,
            is_active, is_builtin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        c.id,
        c.name,
        c.description ?? null,
        c.directoryName,
        c.isActive ? 1 : 0,
        c.isBuiltin ? 1 : 0,
        c.createdAt,
        c.updatedAt,
      );
  }

  findById(id: string): CharacterRow | undefined {
    return this.db
      .prepare('SELECT * FROM characters WHERE id = ?')
      .get(id) as CharacterRow | undefined;
  }

  /** 物理名冲突检查：directory_name 全局唯一。 */
  findByDirectoryName(directoryName: string): CharacterRow | undefined {
    return this.db
      .prepare('SELECT * FROM characters WHERE directory_name = ?')
      .get(directoryName) as CharacterRow | undefined;
  }

  findActive(): CharacterRow | undefined {
    return this.db
      .prepare('SELECT * FROM characters WHERE is_active = 1 LIMIT 1')
      .get() as CharacterRow | undefined;
  }

  list(): CharacterRow[] {
    return this.db
      .prepare('SELECT * FROM characters ORDER BY is_builtin DESC, name ASC')
      .all() as CharacterRow[];
  }

  activate(id: string, updatedAt: number): boolean {
    return this.db.transaction(() => {
      const target = this.db
        .prepare('SELECT is_active FROM characters WHERE id = ?')
        .get(id) as { is_active: number } | undefined;

      // 必须先确认目标存在，避免错误 ID 清空当前角色。
      if (!target) return false;
      if (target.is_active === 1) return true;

      this.db.prepare('UPDATE characters SET is_active = 0 WHERE is_active = 1').run();
      this.db
        .prepare('UPDATE characters SET is_active = 1, updated_at = ? WHERE id = ?')
        .run(updatedAt, id);
      return true;
    })();
  }

  update(id: string, patch: CharacterUpdate): void {
    const untrustedPatch = patch as CharacterUpdate & Record<string, unknown>;
    for (const field of ['isActive', 'isBuiltin', 'directoryName'] as const) {
      if (Object.prototype.hasOwnProperty.call(untrustedPatch, field)) {
        throw new CharacterUpdateContractError(field);
      }
    }

    const now = patch.updatedAt ?? Date.now();
    const fields: string[] = [];
    const values: unknown[] = [];

    if (patch.name !== undefined)        { fields.push('name = ?'); values.push(patch.name); }
    if (patch.description !== undefined) { fields.push('description = ?'); values.push(patch.description); }
    if (fields.length === 0) return;
    fields.push('updated_at = ?');
    values.push(now, id);

    this.db.prepare(`UPDATE characters SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  delete(id: string): ProtectedDeleteResult {
    return this.db.transaction(() => {
      const deleted = this.db
        .prepare('DELETE FROM characters WHERE id = ? AND is_builtin = 0')
        .run(id);
      if (deleted.changes === 1) return 'deleted';

      const existing = this.db
        .prepare('SELECT 1 FROM characters WHERE id = ?')
        .get(id);
      return existing ? 'builtin_protected' : 'not_found';
    })();
  }
}
