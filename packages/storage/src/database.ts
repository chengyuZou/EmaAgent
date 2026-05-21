import BetterSqlite3 from 'better-sqlite3';
import { MigrationsRunner, type DatabaseKind } from './migrations.js';

export type SqliteDb = BetterSqlite3.Database;

export type DatabaseOptions =
  | { path: string; kind: DatabaseKind; memory?: false }
  | { memory: true;  kind: DatabaseKind; path?: never };

/**
 * SQLite wrapper. Two flavours coexist in V1:
 *
 *   kind: 'profile' — `~/.ema-agent/profile.db`
 *     provider configs, model bindings, character cards, app settings.
 *     One per process, shared across all registered data dirs.
 *
 *   kind: 'data'    — `{activeDataDir}/data.db`
 *     sessions, memory, audio, artifacts, etc. Swapped when the user
 *     switches data dir.
 *
 * The runtime keeps one of each open simultaneously. Repos take `SqliteDb`
 * directly and don't care which kind they're attached to — the wiring layer
 * pairs each repo with the correct DB.
 */
export class Database {
  readonly sqlite: SqliteDb;
  readonly kind:   DatabaseKind;
  private readonly migrations: MigrationsRunner;

  constructor(opts: DatabaseOptions) {
    this.sqlite = opts.memory
      ? new BetterSqlite3(':memory:')
      : new BetterSqlite3(opts.path);
    this.kind = opts.kind;

    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('synchronous = NORMAL');

    this.migrations = new MigrationsRunner(this.sqlite, this.kind);
  }

  /** Apply pending migrations for this DB's kind. Call once at startup. */
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
