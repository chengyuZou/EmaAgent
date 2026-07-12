import BetterSqlite3 from 'better-sqlite3';
import { MigrationsRunner, type DatabaseKind } from './migrations.js';

export type SqliteDb = BetterSqlite3.Database;

export type DatabaseOptions =
  | { path: string; kind: DatabaseKind; memory?: false }
  | { memory: true;  kind: DatabaseKind; path?: never };

/**
 * SQLite 封装。V1 中两种 kind 共存：
 *
 *   kind: 'profile' - `~/.ema-agent/profile.db`
 *     Provider 配置、模型绑定、角色卡、应用设置。
 *     每进程一个,跨所有已注册数据目录共享。
 *
 *   kind: 'data'    - `{activeDataDir}/data.db`
 *     Session / Memory / 音频 / Artifact 等。用户切换数据目录时随之切换。
 *
 * 运行时同时各开一个。Repo 直接接收 `SqliteDb`,不关心 kind——
 * 由装配层把每个 repo 和正确的 DB 配对。
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

  /** 应用该 DB kind 的待执行迁移。启动时调用一次。 */
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
