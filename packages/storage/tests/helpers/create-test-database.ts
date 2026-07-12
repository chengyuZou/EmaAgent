import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database, type SqliteDb } from '../../src/database.js';

export interface TestDatabase {
  readonly db: SqliteDb;
  close(): void;
}

/**
 * Creates an isolated file-backed data database and applies the production
 * migrations. File-backed SQLite keeps WAL, pragma and temporary-table
 * behaviour aligned with the desktop sidecar.
 */
export function createTestDatabase(): TestDatabase {
  const directory = mkdtempSync(join(tmpdir(), 'ema-storage-test-'));
  const database = new Database({
    path: join(directory, 'data.db'),
    kind: 'data',
  });

  try {
    database.migrate();
  } catch (error) {
    database.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  let closed = false;
  return {
    db: database.sqlite,
    close(): void {
      if (closed) return;
      closed = true;
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
