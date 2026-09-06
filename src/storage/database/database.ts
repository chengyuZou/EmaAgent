import BetterSqlite3 from 'better-sqlite3';
import { MigrationsRunner, type DatabaseKind } from './migrationsRunner.js';
import { extractMessageSearchText, tokenizeMessageSearchText } from '../search/message-search.js';

export type SqliteDb = BetterSqlite3.Database;

export type DatabaseOptions =
  | { path: string; kind: DatabaseKind; memory?: false; readonly?: boolean }
  | { memory: true;  kind: DatabaseKind; path?: never; readonly?: never };

export class DatabaseCapabilityError extends Error {
  readonly code = 'storage/capability-unavailable';

  constructor(readonly capability: 'fts5', readonly platform: NodeJS.Platform) {
    super(`SQLite capability ${capability} is unavailable on ${platform}`);
    this.name = 'DatabaseCapabilityError';
  }
}

/**
 * SQLite 封装。V1 中三种 kind 共存,各开一个 Database 实例:
 *
 *   kind: 'profile' - `~/.ema-agent/profile.db`
 *     Provider 配置、模型绑定、角色卡、应用设置。
 *     每进程一个,跨所有已注册数据目录共享。
 *
 *   kind: 'data'    - `{activeDataDir}/data.db`
 *     Session / Memory / 音频 等。用户切换数据目录时随之切换。
 *
 *   kind: 'kb'      - `{kbPath}/kb.db`
 *     单个命名知识库的文档 / 分块 / FTS5 索引。每个 KB 独立一个。
 *
 * 运行时三个实例同时打开。Repo 直接接收 `SqliteDb`,不关心 kind--
 * 由装配层把每个 repo 和正确的 DB 配对。
 *
 * 生命周期:构造(打开 + 设 pragma)-> `migrate()`(建表)-> 使用 -> `close()`。
 * `migrate()` 必须在使用前调一次,否则无表运行时崩。
 */
export class Database {
  readonly sqlite: SqliteDb;
  readonly kind:   DatabaseKind;
  private readonly migrations: MigrationsRunner;
  private migrated = false;
  private closed   = false;

  constructor(opts: DatabaseOptions) {
    const sqlite = opts.memory
      ? new BetterSqlite3(':memory:')
      : new BetterSqlite3(opts.path, { readonly: opts.readonly === true });

    try {
      // WAL:写先入 -wal 日志,读不阻塞写。foreign_keys:SQLite 默认关,需显式开。
      // synchronous=NORMAL:WAL 下安全且快(每事务不强制 fsync)。
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('foreign_keys = ON');
      sqlite.pragma('synchronous = NORMAL');
      // busy_timeout:多连接并发写时等 5s 再报 SQLITE_BUSY(sidecar 与 migrate-cli 并发场景)。
      sqlite.pragma('busy_timeout = 5000');
      // 性能:内存缓存 20MB + 临时表入内存 + 文件 mmap 256MB(仅文件 DB)。
      sqlite.pragma('cache_size = -20000');
      sqlite.pragma('temp_store = MEMORY');
      if (!opts.memory) sqlite.pragma('mmap_size = 268435456');

      const hasFts5 = sqlite
        .prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled")
        .pluck()
        .get() as number;
      if (opts.kind !== 'profile' && hasFts5 !== 1) {
        throw new DatabaseCapabilityError('fts5', process.platform);
      }

      // data migration 的 message search trigger 会调用这两个同步函数。
      // 所有 repo 共用同一连接，因此普通 insert、fork 和恢复导入都走同一索引管线。
      sqlite.function('ema_message_search_text', { deterministic: true }, extractMessageSearchText);
      sqlite.function('ema_segment_fts', { deterministic: true }, tokenizeMessageSearchText);
    } catch (err) {
      // pragma 失败(如磁盘只读)时关闭已打开的句柄,避免泄漏 + -wal 残留。
      try { sqlite.close(); } catch { /* close 失败忽略,优先抛原错 */ }
      throw err;
    }

    this.sqlite     = sqlite;
    this.kind       = opts.kind;
    this.migrations = new MigrationsRunner(this.sqlite, this.kind);
  }

  /** 应用该 DB kind 的待执行迁移。启动时调用一次;幂等,重复调 no-op。 */
  migrate(): void {
    if (this.closed)   throw new Error('Database already closed');
    if (this.migrated) return;
    this.migrations.run();
    this.migrated = true;
  }

  currentVersion(): number {
    if (this.closed) throw new Error('Database already closed');
    return this.migrations.currentVersion();
  }

  close(): void {
    if (this.closed) return;
    this.sqlite.close();
    this.closed = true;
  }
}
