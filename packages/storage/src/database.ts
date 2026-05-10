import BetterSqlite3 from 'better-sqlite3';
import { MigrationsRunner } from './migrations.js';

export type SqliteDb = BetterSqlite3.Database;

export type DatabaseOptions =
  | { path: string; memory?: false }
  | { memory: true; path?: never };

export class Database {
  readonly sqlite: SqliteDb;
  private readonly migrations: MigrationsRunner;

  constructor(opts: DatabaseOptions) {
    this.sqlite = opts.memory
      ? new BetterSqlite3(':memory:')
      : new BetterSqlite3(opts.path);

    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('synchronous = NORMAL');

    this.migrations = new MigrationsRunner(this.sqlite);
  }

  /** Run pending migrations. Call once at startup. */
  migrate(): void {
    this.migrations.run();
  }

  currentVersion(): number {
    return this.migrations.currentVersion();
  }

  close(): void {
    this.sqlite.close();
  }
}
