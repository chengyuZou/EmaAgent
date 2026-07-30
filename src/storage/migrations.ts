import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(dirname, 'migrations');

/**
 * 三条独立迁移流,各自 DB 的 `user_version` pragma 跟踪:
 *   profile.db -> migrations/profile/  Provider 配置/模型绑定/角色卡/设置/全局记忆/KB 注册
 *   data.db    -> migrations/data/     sessions/turns/messages/音频/agent tasks
 *   kb.db      -> migrations/kb/       单个命名 KB 的文档/分块/FTS5 索引
 *
 * 三条流独立:profile 可 v3 而 data v7(或反之)。版本只在自己文件夹内推进。
 *
 * 铁律:迁移**只追加,不 squash(合并),编号发布后不可改**。否则老库 `user_version > latest`
 * 会被 compatibility gate 拦下(见 `run()`)。未来确需 squash,引入 `_migrations` checksum 表
 * + baseline 机制(参考 Flyway),V1 不需要。
 */
export type DatabaseKind = 'profile' | 'data' | 'kb';

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
        `[${this.kind}] 数据库版本 v${current} 高于本包最新 v${latest},可能用了更新版本的应用。请升级应用或备份数据后重建`,
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
}
