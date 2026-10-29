import { createSqliteIdBatches } from '../../database/sqlite-id-batches.js';
import type { SqliteDb } from '../../database/database.js';

export interface CharacterStickerRow {
  character_name: string;
  name: string;
  display_name: string;
  description: string;
  byte_size: number;
  created_at: number;
  updated_at: number;
}

export class CharacterStickerRepo {
  constructor(private readonly db: SqliteDb) {}

  list(characterName: string): CharacterStickerRow[] {
    return this.db.prepare('SELECT * FROM character_stickers WHERE character_name = ? ORDER BY created_at, name')
      .all(characterName) as CharacterStickerRow[];
  }

  listForCharacters(characterNames: readonly string[]): CharacterStickerRow[] {
    const rows: CharacterStickerRow[] = [];
    for (const batch of createSqliteIdBatches(this.db, characterNames)) {
      rows.push(...this.db.prepare(
        `SELECT * FROM character_stickers WHERE character_name IN (${batch.map(() => '?').join(', ')}) ORDER BY character_name, created_at, name`,
      ).all(...batch) as CharacterStickerRow[]);
    }
    return rows;
  }

  find(characterName: string, name: string): CharacterStickerRow | undefined {
    return this.db.prepare('SELECT * FROM character_stickers WHERE character_name = ? AND name = ?')
      .get(characterName, name) as CharacterStickerRow | undefined;
  }

  insert(row: CharacterStickerRow): void {
    this.db.prepare(`INSERT INTO character_stickers
      (character_name, name, display_name, description, byte_size, created_at, updated_at)
      VALUES (@character_name, @name, @display_name, @description, @byte_size, @created_at, @updated_at)`).run(row);
  }

  update(characterName: string, name: string, displayName: string, description: string, updatedAt: number): void {
    this.db.prepare('UPDATE character_stickers SET display_name = ?, description = ?, updated_at = ? WHERE character_name = ? AND name = ?')
      .run(displayName, description, updatedAt, characterName, name);
  }

  delete(characterName: string, name: string): void {
    this.db.prepare('DELETE FROM character_stickers WHERE character_name = ? AND name = ?')
      .run(characterName, name);
  }
}
