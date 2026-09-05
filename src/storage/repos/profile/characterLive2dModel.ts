import type { SqliteDb } from '../../database/database.js';
import { createSqliteIdBatches } from '../../database/sqlite-id-batches.js';

export interface CharacterLive2dModelRow {
  name: string;
  character_name: string;
  display_name: string;
  stage_scale: number;
  stage_offset_x: number;
  stage_offset_y: number;
  is_primary: number;
  byte_size: number | null;
  created_at: number;
  updated_at: number;
}

export interface CharacterLive2dModelInsert {
  name: string;
  characterName: string;
  displayName: string;
  stageScale?: number;
  stageOffsetX?: number;
  stageOffsetY?: number;
  isPrimary?: boolean;
  byteSize?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterLive2dModelUpdate {
  displayName?: string;
  stageScale?: number;
  stageOffsetX?: number;
  stageOffsetY?: number;
}

export class CharacterLive2dModelRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(input: CharacterLive2dModelInsert): void {
    this.db.transaction(() => {
      if (input.isPrimary) this.clearPrimary(input.characterName, input.updatedAt);
      this.db.prepare(
        `INSERT INTO character_live2d_models (
           name, character_name, display_name,
           stage_scale, stage_offset_x, stage_offset_y, is_primary, byte_size, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.name,
        input.characterName,
        input.displayName,
        input.stageScale ?? 1,
        input.stageOffsetX ?? 0,
        input.stageOffsetY ?? 0,
        input.isPrimary ? 1 : 0,
        input.byteSize ?? null,
        input.createdAt,
        input.updatedAt,
      );
    })();
  }

  find(characterName: string, name: string): CharacterLive2dModelRow | undefined {
    return this.db.prepare(
      'SELECT * FROM character_live2d_models WHERE character_name = ? AND name = ?',
    ).get(characterName, name) as CharacterLive2dModelRow | undefined;
  }

  findPrimary(characterName: string): CharacterLive2dModelRow | undefined {
    return this.db.prepare(
      'SELECT * FROM character_live2d_models WHERE character_name = ? AND is_primary = 1',
    ).get(characterName) as CharacterLive2dModelRow | undefined;
  }

  listForCharacter(characterName: string): CharacterLive2dModelRow[] {
    return this.db.prepare(
      'SELECT * FROM character_live2d_models WHERE character_name = ? ORDER BY created_at, name',
    ).all(characterName) as CharacterLive2dModelRow[];
  }

  listForCharacters(characterNames: readonly string[]): CharacterLive2dModelRow[] {
    const rows: CharacterLive2dModelRow[] = [];
    for (const batch of createSqliteIdBatches(this.db, characterNames)) {
      rows.push(
        ...this.db.prepare(
          `SELECT * FROM character_live2d_models WHERE character_name IN (${batch.map(() => '?').join(', ')}) ORDER BY character_name, created_at, name`,
        ).all(...batch) as CharacterLive2dModelRow[],
      );
    }
    return rows;
  }

  setPrimary(characterName: string, name: string, updatedAt: number): boolean {
    return this.db.transaction(() => {
      if (!this.find(characterName, name)) return false;
      this.clearPrimary(characterName, updatedAt);
      this.db.prepare(
        'UPDATE character_live2d_models SET is_primary = 1, updated_at = ? WHERE character_name = ? AND name = ?',
      ).run(updatedAt, characterName, name);
      return true;
    })();
  }

  update(characterName: string, name: string, patch: CharacterLive2dModelUpdate, updatedAt: number): CharacterLive2dModelRow | undefined {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (patch.displayName !== undefined) {
      fields.push('display_name = ?');
      values.push(patch.displayName);
    }
    if (patch.stageScale !== undefined) {
      fields.push('stage_scale = ?');
      values.push(patch.stageScale);
    }
    if (patch.stageOffsetX !== undefined) {
      fields.push('stage_offset_x = ?');
      values.push(patch.stageOffsetX);
    }
    if (patch.stageOffsetY !== undefined) {
      fields.push('stage_offset_y = ?');
      values.push(patch.stageOffsetY);
    }
    if (fields.length === 0) {
      return this.find(characterName, name);
    }
    fields.push('updated_at = ?');
    values.push(updatedAt, characterName, name);
    this.db.prepare(`UPDATE character_live2d_models SET ${fields.join(', ')} WHERE character_name = ? AND name = ?`).run(...values);
    return this.find(characterName, name);
  }

  delete(characterName: string, name: string): CharacterLive2dModelRow | undefined {
    const row = this.find(characterName, name);
    if (row) {
      this.db.prepare('DELETE FROM character_live2d_models WHERE character_name = ? AND name = ?').run(characterName, name);
    }
    return row;
  }

  private clearPrimary(characterName: string, updatedAt: number): void {
    this.db.prepare(
      'UPDATE character_live2d_models SET is_primary = 0, updated_at = ? WHERE character_name = ? AND is_primary = 1',
    ).run(updatedAt, characterName);
  }
}
