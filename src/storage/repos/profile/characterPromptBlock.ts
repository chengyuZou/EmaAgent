// 角色 Prompt Block 行 CRUD、批量读取与事务重排。
// 只做行存取；字符限制与 Prompt 拼接归 Character 领域包。

import type { SqliteDb } from '../../database/database.js';
import { createSqliteIdBatches } from '../../database/sqlite-id-batches.js';

export interface CharacterPromptBlockRow {
  id: string;
  character_id: string;
  name: string;
  content: string;
  enabled: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface CharacterPromptBlockInsert {
  id: string;
  characterId: string;
  name: string;
  content: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterPromptBlockUpdate {
  name?: string;
  content?: string;
  enabled?: boolean;
  updatedAt?: number;
}

export class CharacterPromptBlockRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(b: CharacterPromptBlockInsert): void {
    this.db.prepare(
      `INSERT INTO character_prompt_blocks
         (id, character_id, name, content, enabled, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      b.id,
      b.characterId,
      b.name,
      b.content,
      b.enabled ? 1 : 0,
      b.sortOrder,
      b.createdAt,
      b.updatedAt,
    );
  }

  insertMany(blocks: readonly CharacterPromptBlockInsert[]): void {
    // CharacterRepository 在创建角色的外层事务内调用，这里只做批量插入。
    for (const block of blocks) this.insert(block);
  }

  findById(characterId: string, id: string): CharacterPromptBlockRow | undefined {
    return this.db.prepare(
      `SELECT * FROM character_prompt_blocks WHERE character_id = ? AND id = ?`,
    ).get(characterId, id) as CharacterPromptBlockRow | undefined;
  }

  listForCharacter(characterId: string): CharacterPromptBlockRow[] {
    return this.db.prepare(
      `SELECT * FROM character_prompt_blocks
       WHERE character_id = ?
       ORDER BY sort_order ASC, id ASC`,
    ).all(characterId) as CharacterPromptBlockRow[];
  }

  listForCharacters(characterIds: readonly string[]): CharacterPromptBlockRow[] {
    const rows: CharacterPromptBlockRow[] = [];
    for (const batch of createSqliteIdBatches(this.db, characterIds)) {
      rows.push(...this.db.prepare(
        `SELECT * FROM character_prompt_blocks
         WHERE character_id IN (${batch.map(() => '?').join(', ')})
         ORDER BY character_id ASC, sort_order ASC, id ASC`,
      ).all(...batch) as CharacterPromptBlockRow[]);
    }
    return rows;
  }

  update(
    characterId: string,
    id: string,
    patch: CharacterPromptBlockUpdate,
  ): CharacterPromptBlockRow | undefined {
    return this.db.transaction(() => {
      const current = this.findById(characterId, id);
      if (!current) return undefined;

      const name = patch.name ?? current.name;
      const content = patch.content ?? current.content;
      const enabled = patch.enabled ?? current.enabled === 1;
      const changed = name !== current.name
        || content !== current.content
        || enabled !== (current.enabled === 1);
      if (!changed) return current;
      const revisionAt = Math.max(patch.updatedAt ?? Date.now(), current.updated_at + 1);

      this.db.prepare(
        `UPDATE character_prompt_blocks
         SET name = ?, content = ?, enabled = ?, updated_at = ?
         WHERE character_id = ? AND id = ?`,
      ).run(name, content, enabled ? 1 : 0, revisionAt, characterId, id);
      return this.findById(characterId, id);
    })();
  }

  delete(characterId: string, id: string): boolean {
    return this.db.prepare(
      `DELETE FROM character_prompt_blocks WHERE character_id = ? AND id = ?`,
    ).run(characterId, id).changes === 1;
  }

  /**
   * 一次提交该角色的完整 Block ID 数组，在一个事务中重排。
   * sort_order = 数组下标。ID 集合必须与现有行完全一致，否则拒绝。
   */
  reorder(
    characterId: string,
    orderedIds: readonly string[],
    updatedAt: number,
  ): boolean {
    return this.db.transaction(() => {
      const existing = this.listForCharacter(characterId);
      if (existing.length !== orderedIds.length) return false;
      const existingIds = new Set(existing.map(row => row.id));
      if (new Set(orderedIds).size !== orderedIds.length) return false;
      for (const id of orderedIds) {
        if (!existingIds.has(id)) return false;
      }
      const stmt = this.db.prepare(
        `UPDATE character_prompt_blocks
         SET sort_order = ?, updated_at = ?
         WHERE character_id = ? AND id = ?`,
      );
      orderedIds.forEach((id, index) => stmt.run(index, updatedAt, characterId, id));
      return true;
    })();
  }
}
