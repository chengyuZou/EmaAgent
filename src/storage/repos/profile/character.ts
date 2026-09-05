import type { SqliteDb } from '../../database/database.js';

export interface CharacterRow {
  name: string;
  display_name: string | null;
  description: string | null;
  persona_prompt: string;
  stage_kind: 'live2d' | 'illustration' | 'blank';
  is_active: number;
  last_activated_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CharacterInsert {
  name: string;
  displayName?: string | null;
  description?: string | null;
  personaPrompt: string;
  stageKind?: CharacterRow['stage_kind'];
  isActive?: boolean;
  lastActivatedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterUpdate {
  displayName?: string | null;
  description?: string | null;
  personaPrompt?: string;
  stageKind?: CharacterRow['stage_kind'];
  updatedAt?: number;
}

export type CharacterDeleteResult =
  | 'deleted'
  | 'not_found'
  | 'last_character'
  | 'replacement_not_found';

export class CharacterRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(character: CharacterInsert): void {
    this.db.prepare(
      `INSERT INTO characters (
         name, display_name, description, persona_prompt, stage_kind,
         is_active, last_activated_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      character.name,
      character.displayName ?? null,
      character.description ?? null,
      character.personaPrompt,
      character.stageKind ?? 'blank',
      character.isActive ? 1 : 0,
      character.lastActivatedAt ?? null,
      character.createdAt,
      character.updatedAt,
    );
  }

  findByName(name: string): CharacterRow | undefined {
    return this.db.prepare('SELECT * FROM characters WHERE name = ?').get(name) as CharacterRow | undefined;
  }

  findActive(): CharacterRow | undefined {
    return this.db.prepare('SELECT * FROM characters WHERE is_active = 1 LIMIT 1').get() as CharacterRow | undefined;
  }

  list(): CharacterRow[] {
    return this.db.prepare(
      'SELECT * FROM characters ORDER BY is_active DESC, last_activated_at DESC, created_at ASC',
    ).all() as CharacterRow[];
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS count FROM characters').get() as { count: number }).count;
  }

  activate(name: string, activatedAt: number): boolean {
    return this.db.transaction(() => {
      const target = this.findByName(name);
      if (!target) return false;
      if (target.is_active === 1) return true;
      this.db.prepare('UPDATE characters SET is_active = 0 WHERE is_active = 1').run();
      this.db.prepare(
        'UPDATE characters SET is_active = 1, last_activated_at = ?, updated_at = ? WHERE name = ?',
      ).run(activatedAt, activatedAt, name);
      return true;
    })();
  }

  update(name: string, patch: CharacterUpdate): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (patch.displayName !== undefined) {
      fields.push('display_name = ?');
      values.push(patch.displayName);
    }
    if (patch.description !== undefined) {
      fields.push('description = ?');
      values.push(patch.description);
    }
    if (patch.personaPrompt !== undefined) {
      fields.push('persona_prompt = ?');
      values.push(patch.personaPrompt);
    }
    if (patch.stageKind !== undefined) {
      fields.push('stage_kind = ?');
      values.push(patch.stageKind);
    }
    if (fields.length === 0) {
      return;
    }
    fields.push('updated_at = ?');
    values.push(patch.updatedAt ?? Date.now(), name);
    this.db.prepare(`UPDATE characters SET ${fields.join(', ')} WHERE name = ?`).run(...values);
  }

  touch(name: string, updatedAt: number): void {
    this.db.prepare('UPDATE characters SET updated_at = ? WHERE name = ?').run(updatedAt, name);
  }

  delete(name: string, replacementName?: string): CharacterDeleteResult {
    return this.db.transaction(() => {
      const target = this.findByName(name);
      if (!target) return 'not_found';

      const count = (this.db.prepare('SELECT COUNT(*) AS count FROM characters').get() as { count: number }).count;
      if (count === 1) return 'last_character';

      if (target.is_active === 1) {
        if (!replacementName || replacementName === name || !this.findByName(replacementName)) {
          return 'replacement_not_found';
        }
        const now = Date.now();
        this.db.prepare('UPDATE characters SET is_active = 0 WHERE name = ?').run(name);
        this.db.prepare(
          'UPDATE characters SET is_active = 1, last_activated_at = ?, updated_at = ? WHERE name = ?',
        ).run(now, now, replacementName);
      }

      this.db.prepare('DELETE FROM characters WHERE name = ?').run(name);
      return 'deleted';
    })();
  }
}
