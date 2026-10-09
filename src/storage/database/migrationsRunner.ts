import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(dirname, '..', 'migrations');
const NARRATIVE_VERSION = 1;
const SEED_READ_BYTES = 64 * 1024;
const SEED_EXEC_CHARS = 512 * 1024;
const NARRATIVE_SEED_FILES = [
  'narrative-seeds-1st.sql',
  'narrative-seeds-2nd.sql',
  'narrative-seeds-3rd.sql',
] as const;

/**
 * 各个数据库使用独立的 `user_version`:
 *   profile.db -> migrations/profile/  Provider 配置/模型绑定/角色卡/设置/全局记忆
 *   data.db    -> migrations/data/     sessions/turns/messages/音频/agent tasks
 *   narrative.db -> migrations/narrative/ 具名 schema 和固定剧情种子, 初始版本为 1.
 *
 * profile/data 按数字编号逐个迁移, narrative 首次执行两份定义和三份种子 SQL.
 */
export type DatabaseKind = 'profile' | 'data' | 'narrative';

export class MigrationsRunner {
  constructor(
    private readonly db:   Database.Database,
    private readonly kind: DatabaseKind,
  ) {}

  /**
   * 应用 `migrations/{kind}/` 下每个 pending 迁移。每个迁移与 `user_version` bump 在单个事务内,
   * 不留半成品。幂等:已应用的跳过,崩溃后重跑从下一条开始。
   */
  run(): void {
    const folder = path.join(MIGRATIONS_DIR, this.kind);
    if (this.kind === 'narrative') {
      this.initializeNarrative(folder);
      return;
    }
    let entries: string[];
    try {
      entries = fs.readdirSync(folder).filter(f => f.endsWith('.sql'));
    } catch (err) {
      throw new Error(
        `[${this.kind}] 迁移目录不存在或不可读: ${folder} (${(err as NodeJS.ErrnoException).code ?? err})`,
      );
    }

    // 从文件名前缀解析版本号(001_xxx.sql -> 1),取最大值。不靠 entries.length,
    // 避免 squash(编号回退)或跳号时 latest 算错。
    const versions = entries
      .map(f => parseInt(f.slice(0, 3), 10))
      .filter(n => Number.isInteger(n) && n > 0);
    const latest = versions.length ? Math.max(...versions) : 0;

    const current = this.db.pragma('user_version', { simple: true }) as number;

    // compatibility gate:老库 user_version 高于本包最新,说明用了更新版本的应用,
    // 本包无法降级迁移。fail-closed,防静默跳过致 schema 不一致。
    if (current > latest) {
      throw new Error(
        `[${this.kind}] 数据库版本 v${current} 高于本包最新 v${latest}。可能使用了更新版本，或仍是基线重置前的开发库；请升级应用，或备份后重建开发数据库`,
      );
    }

    for (let v = current + 1; v <= latest; v++) {
      if (!Number.isInteger(v) || v <= 0) {
        throw new Error(`[${this.kind}] 非法迁移版本号: ${v}`);
      }
      const prefix   = String(v).padStart(3, '0') + '_';
      const filename = entries.find(f => f.startsWith(prefix));
      if (!filename) {
        // 跳号(如 001/002/004 缺 003):明确报错,不静默跳过。
        throw new Error(
          `[${this.kind}] 迁移 ${v} 缺失(目录 ${folder} 有跳号),expected file ${prefix}*.sql`,
        );
      }
      const sql = fs.readFileSync(path.join(folder, filename), 'utf8');
      const rebuildsReferencedTable = sql.includes(
        '-- ema:migration foreign_keys=off',
      );
      if (rebuildsReferencedTable) {
        // SQLite 在外键开启时会把子表引用同步改名到临时表。重建被引用表必须在
        // 事务外临时关闭外键，再在提交前用 foreign_key_check 验证最终关系。
        this.db.pragma('foreign_keys = OFF');
      }
      try {
        this.db.transaction(() => {
          this.db.exec(sql);
          if (rebuildsReferencedTable) {
            const violations = this.db.pragma('foreign_key_check') as unknown[];
            if (violations.length > 0) {
              throw new Error(
                `[${this.kind}] 迁移 ${v} 重建表后留下 ${violations.length} 个外键错误`,
              );
            }
          }
          this.db.pragma(`user_version = ${v}`);
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

  private initializeNarrative(folder: string): void {
    const current = this.currentVersion();
    if (current === NARRATIVE_VERSION) {
      return;
    }
    if (current > NARRATIVE_VERSION) {
      throw new Error(`[narrative] 数据库版本 v${current} 高于支持的 v${NARRATIVE_VERSION}`);
    }

    // 三周目和缓存 schema 全部成功才记录版本; 出错时连建表一起回滚.
    this.db.transaction(() => {
      this.db.exec(fs.readFileSync(path.join(folder, 'narrative.sql'), 'utf8'));
      this.db.exec(fs.readFileSync(path.join(folder, 'narrative-cache.sql'), 'utf8'));
      for (const filename of NARRATIVE_SEED_FILES) {
        this.executeNarrativeSeeds(path.join(folder, filename));
      }
      this.db.pragma(`user_version = ${NARRATIVE_VERSION}`);
    })();
  }

  private executeNarrativeSeeds(filename: string): void {
    const fd = fs.openSync(filename, 'r');
    const buffer = Buffer.allocUnsafe(SEED_READ_BYTES);
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let scanOffset = 0;
    let inString = false;

    // 生成器输出 INSERT 和固定文件头. 原文可以含换行和分号, 只能在字符串外的分号后分批.
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
