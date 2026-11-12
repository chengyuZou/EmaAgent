import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { createPreMigrationBackup, prunePreMigrationBackups } from './preMigrationBackup.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(dirname, '..', 'migrations');
const SEED_READ_BYTES = 64 * 1024;
const SEED_EXEC_CHARS = 512 * 1024;

interface NumberedMigrations {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly files: ReadonlyArray<{ version: number; filename: string }>;
}

/**
 * 各个数据库使用独立的 `user_version`:
 *   profile.db -> migrations/profile/  Provider 配置, 模型绑定, 角色和设置
 *   data.db    -> migrations/data/     sessions/turns/messages/音频/agent tasks
 *   narrative.db -> migrations/narrative/ 表定义和应用自带的剧情数据
 * 三个库都按各自目录的 SQL 文件编号升级.
 */
export type DatabaseKind = 'profile' | 'data' | 'narrative';

export class MigrationsRunner {
  constructor(
    private readonly db:   Database.Database,
    private readonly kind: DatabaseKind,
  ) {}

  /**
   * 已提交的版本跳过. 每份 SQL 与其 user_version 更新处于同一事务,
   * 失败只回滚当前文件, 下次启动从未提交的版本继续.
   */
  async run(directory?: string): Promise<void> {
    const migrations = this.readNumberedMigrations();
    // Narrative 由随应用发放的 SQL 重建. 迁移前副本只用于保存用户写入的 Profile 和 Data.
    if (this.kind === 'narrative' || this.db.memory || migrations.fromVersion === 0 || migrations.files.length === 0) {
      this.applyNumberedMigrations(migrations.files);
      return;
    }
    const backupDirectory = directory ?? path.join(path.dirname(this.db.name), 'pre-migration');
    await createPreMigrationBackup(
      this.db, this.kind, backupDirectory, migrations.fromVersion, migrations.toVersion,
    );
    this.applyNumberedMigrations(migrations.files);
    await prunePreMigrationBackups(backupDirectory, this.kind);
  }

  private readNumberedMigrations(): NumberedMigrations {
    const folder = path.join(MIGRATIONS_DIR, this.kind);
    let entries: string[];
    try {
      entries = fs.readdirSync(folder).filter(f => f.endsWith('.sql'));
    } catch (err) {
      throw new Error(
        `[${this.kind}] 迁移目录不存在或不可读: ${folder} (${(err as NodeJS.ErrnoException).code ?? err})`,
      );
    }

    // 取文件编号的最大值, 不用文件数量, 才能发现中间缺失的编号.
    const versions = entries
      .map(f => parseInt(f.slice(0, 3), 10))
      .filter(n => Number.isInteger(n) && n > 0);
    const latest = versions.length ? Math.max(...versions) : 0;

    const current = this.currentVersion();

    // 旧应用不能把较新结构当作自己的表使用, 也不能靠改版本号撤销迁移.
    if (current > latest) {
      throw new Error(
        `[${this.kind}] 数据库版本 v${current} 高于本包最新 v${latest}. 请使用支持该版本的应用, 或由使用者备份后重建开发数据库`,
      );
    }

    let firstPendingVersion = current + 1;
    if (this.kind === 'narrative') {
      const schemaFilename = entries.find(filename => /^\d{3}_narrativeSchema\.sql$/u.test(filename));
      if (!schemaFilename) {
        throw new Error(`[narrative] 缺少重建剧情表的 SQL: ${folder}`);
      }
      const schemaVersion = Number(schemaFilename.slice(0, 3));
      const initialDataFilename = `${String(schemaVersion + 1).padStart(3, '0')}_narrativeData.sql`;
      if (!entries.includes(initialDataFilename)) {
        throw new Error(`[narrative] 缺少初始化剧情数据的 SQL: ${initialDataFilename}`);
      }

      // 首份表迁移可直接重建旧剧情库, 空库也从这份 SQL 开始. 之后的文件仍须逐号执行.
      firstPendingVersion = Math.max(firstPendingVersion, schemaVersion);
    }

    const files: Array<{ version: number; filename: string }> = [];
    for (let v = firstPendingVersion; v <= latest; v++) {
      if (!Number.isInteger(v) || v <= 0) {
        throw new Error(`[${this.kind}] 非法迁移版本号: ${v}`);
      }
      const prefix   = String(v).padStart(3, '0') + '_';
      const filename = entries.find(f => f.startsWith(prefix));
      if (!filename) {
        // 跳号(如 001/002/004 缺 003):明确报错,不静默跳过.
        throw new Error(
          `[${this.kind}] 迁移 ${v} 缺失(目录 ${folder} 有跳号),expected file ${prefix}*.sql`,
        );
      }
      files.push({ version: v, filename: path.join(folder, filename) });
    }
    return { fromVersion: current, toVersion: latest, files };
  }

  private applyNumberedMigrations(files: NumberedMigrations['files']): void {
    for (const { version, filename } of files) {
      const isNarrativeData = this.kind === 'narrative' && filename.endsWith('_narrativeData.sql');
      const sql = isNarrativeData ? undefined : fs.readFileSync(filename, 'utf8');
      const rebuildsReferencedTable = sql?.includes('-- ema:migration foreign_keys=off') === true;
      if (rebuildsReferencedTable) {
        // SQLite 在外键开启时会把子表引用同步改名到临时表.重建被引用表必须在
        // 事务外临时关闭外键,再在提交前用 foreign_key_check 验证最终关系.
        this.db.pragma('foreign_keys = OFF');
      }
      try {
        this.db.transaction(() => {
          if (sql === undefined) {
            this.executeNarrativeInserts(filename);
          } else {
            this.db.exec(sql);
          }
          if (rebuildsReferencedTable) {
            const violations = this.db.pragma('foreign_key_check') as unknown[];
            if (violations.length > 0) {
              throw new Error(
                `[${this.kind}] 迁移 ${version} 重建表后留下 ${violations.length} 个外键错误`,
              );
            }
          }
          this.db.pragma(`user_version = ${version}`);
        })();
      } finally {
        if (rebuildsReferencedTable) {
          this.db.pragma('foreign_keys = ON');
        }
      }
    }
  }

  currentVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number;
  }

  private executeNarrativeInserts(filename: string): void {
    const fd = fs.openSync(filename, 'r');
    const buffer = Buffer.allocUnsafe(SEED_READ_BYTES);
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let scanOffset = 0;
    let inString = false;

    // 剧情导出只包含 INSERT. 原文可以含换行和分号, 只能在字符串外的分号后分批.
    // 字符串里的两个连续单引号表示一个原文单引号, 两次切换后仍处于字符串内.
    const executeStatements = (text: string): void => {
      pending += text;
      while (scanOffset < pending.length) {
        const character = pending[scanOffset];
        if (character === "'") {
          inString = !inString;
        } else if (character === ';' && !inString && scanOffset + 1 >= SEED_EXEC_CHARS) {
          this.db.exec(pending.slice(0, scanOffset + 1));
          pending = pending.slice(scanOffset + 1);
          scanOffset = 0;
          continue;
        }
        scanOffset += 1;
      }
    };

    try {
      let count = fs.readSync(fd, buffer);
      while (count > 0) {
        executeStatements(decoder.write(buffer.subarray(0, count)));
        count = fs.readSync(fd, buffer);
      }
      executeStatements(decoder.end());
      this.db.exec(pending);
    } finally {
      fs.closeSync(fd);
    }
  }
}
