import type { SqliteDb } from '../database.js';

export interface Live2DModelRow {
  id: string;
  name: string;
  format: 'live2d' | 'vrm';
  storage_path: string;
  params_json: string;
  is_builtin: number;
  created_at: number;
  updated_at: number;
}

export class Live2DModelsRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(row: Omit<Live2DModelRow, never>): void {
    this.db
      .prepare(
        `INSERT INTO live2d_models (id, name, format, storage_path, params_json, is_builtin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.name, row.format, row.storage_path,
        row.params_json, row.is_builtin, row.created_at, row.updated_at,
      );
  }

  findById(id: string): Live2DModelRow | undefined {
    return this.db
      .prepare('SELECT * FROM live2d_models WHERE id = ?')
      .get(id) as Live2DModelRow | undefined;
  }

  list(): Live2DModelRow[] {
    return this.db
      .prepare('SELECT * FROM live2d_models ORDER BY is_builtin DESC, name ASC')
      .all() as Live2DModelRow[];
  }

  updateParams(id: string, paramsJson: string, updatedAt: number): void {
    this.db
      .prepare('UPDATE live2d_models SET params_json = ?, updated_at = ? WHERE id = ?')
      .run(paramsJson, updatedAt, id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM live2d_models WHERE id = ? AND is_builtin = 0').run(id);
  }
}
