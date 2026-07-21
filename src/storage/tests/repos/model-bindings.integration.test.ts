import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Database,
  ModelBindingsRepo,
  MigrationsRunner,
  ProvidersRepo,
} from '../../index.js';
import { createTestCredentialFacade } from '../helpers/test-credential-facade.js';

// B-024：setSingle 必须把“删旧 + 插新”包进同一事务，upsert 失败时旧绑定回滚保留。
describe('B-024 ModelBindings setSingle 事务原子性', () => {
  let database: Database;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    new ProvidersRepo(database.sqlite, createTestCredentialFacade()).upsert({
      id: 'provider-1',
      definitionId: 'siliconflow',
      displayName: 'Provider',
      apiKey: 'secret',
      capabilities: [{ capability: 'llm' }],
    });
  });

  afterEach(() => database.close());

  it('setSingle 成功时旧绑定被新绑定替换', () => {
    const bindings = new ModelBindingsRepo(database.sqlite);
    bindings.upsert({ module: 'emotion', providerConfigId: 'provider-1', model: 'old-model' });

    bindings.setSingle({ module: 'emotion', providerConfigId: 'provider-1', model: 'new-model' });

    expect(bindings.listByModule('emotion').map((r) => r.model)).toEqual(['new-model']);
  });

  it('setSingle 中途 upsert 失败时旧绑定保留（事务回滚，不丢配置）', () => {
    const bindings = new ModelBindingsRepo(database.sqlite);
    bindings.upsert({ module: 'emotion', providerConfigId: 'provider-1', model: 'old-model' });

    // upsert 失败场景：provider_config_id 的 FK 不存在 -> 违反外键约束。
    // setSingle 先 deleteAll（删掉 old-model），再 upsert（FK 失败抛错）；
    // 事务必须回滚把 old-model 还回来，否则模块瞬间失去全部绑定。
    expect(() =>
      bindings.setSingle({ module: 'emotion', providerConfigId: 'missing-provider', model: 'new-model' }),
    ).toThrow(/FOREIGN KEY constraint failed/);

    expect(bindings.listByModule('emotion').map((r) => r.model)).toEqual(['old-model']);
  });
});

// B-058：get()/listByModule() 必须有 ORDER BY，保证多候选时默认绑定确定不跳变。
describe('B-058 ModelBindings 确定性排序', () => {
  let database: Database;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    const providers = new ProvidersRepo(database.sqlite, createTestCredentialFacade());
    providers.upsert({ id: 'p-zeta', definitionId: 'siliconflow', displayName: 'Z', apiKey: 'x', capabilities: [{ capability: 'llm' }] });
    providers.upsert({ id: 'p-alpha', definitionId: 'siliconflow', displayName: 'A', apiKey: 'x', capabilities: [{ capability: 'llm' }] });
  });

  afterEach(() => database.close());

  it('get() 多行时按 (provider_config_id, model) 稳定返回首行', () => {
    const bindings = new ModelBindingsRepo(database.sqlite);
    // 故意以非字典序插入，验证排序不是“插入序”
    bindings.upsert({ module: 'router', providerConfigId: 'p-zeta', model: 'z-model' });
    bindings.upsert({ module: 'router', providerConfigId: 'p-alpha', model: 'm-model' });
    bindings.upsert({ module: 'router', providerConfigId: 'p-alpha', model: 'a-model' });

    const first = bindings.get('router');
    expect(first?.providerConfigId).toBe('p-alpha');
    expect(first?.model).toBe('a-model');
  });

  it('listByModule() 按 (provider_config_id, model) 稳定排序', () => {
    const bindings = new ModelBindingsRepo(database.sqlite);
    bindings.upsert({ module: 'router', providerConfigId: 'p-zeta', model: 'z-model' });
    bindings.upsert({ module: 'router', providerConfigId: 'p-alpha', model: 'm-model' });
    bindings.upsert({ module: 'router', providerConfigId: 'p-alpha', model: 'a-model' });

    expect(bindings.listByModule('router').map((r) => [r.providerConfigId, r.model]))
      .toEqual([
        ['p-alpha', 'a-model'],
        ['p-alpha', 'm-model'],
        ['p-zeta', 'z-model'],
      ]);
  });
});

// 005 迁移：清理 retired 模块残留行 + CHECK 从 17 收紧到 11。
describe('profile v4 到当前版本迁移：model_bindings CHECK 收紧到 11', () => {
  it('清理 retired 模块残留行并收紧 CHECK，保留 11 模块存量', () => {
    const sqlite = new BetterSqlite3(':memory:');
    try {
      sqlite.pragma('foreign_keys = ON');
      applyProfileMigrationsThroughV4(sqlite);
      // 存量 provider（裸 SQL，最小列，其余走默认值）
      sqlite.prepare(
        `INSERT INTO provider_configs
           (id, definition_id, display_name, created_at, updated_at)
         VALUES ('p-1', 'siliconflow', 'P', 1, 1)`,
      ).run();
      // retired 模块残留行（TS BindingModule 不允许，只能裸 SQL 模拟旧库存量）
      const insBinding = sqlite.prepare(
        `INSERT INTO model_bindings
           (module, provider_config_id, model, voice_id, config_json)
         VALUES (?, 'p-1', ?, NULL, '{}')`,
      );
      insBinding.run('chat', 'chat-model');
      insBinding.run('embed', 'embed-model');
      // 11 模块存量（走 Repo 类型安全路径）
      new ModelBindingsRepo(sqlite).upsert({ module: 'router', providerConfigId: 'p-1', model: 'router-model' });
      new ModelBindingsRepo(sqlite).upsert({ module: 'tts', providerConfigId: 'p-1', model: 'tts-model' });

      new MigrationsRunner(sqlite, 'profile').run();

      const remaining = sqlite.prepare('SELECT module FROM model_bindings ORDER BY module ASC')
        .all() as Array<{ module: string }>;
      expect(remaining.map((r) => r.module)).toEqual(['router', 'tts']);

      // CHECK 已收紧：retired 模块写入被拒
      expect(() => insBinding.run('chat', 'x')).toThrow(/CHECK constraint failed/);
      // 11 模块写入仍正常
      expect(() => insBinding.run('vision', 'v-model')).not.toThrow();

      expect(sqlite.pragma('user_version', { simple: true })).toBe(9);
    } finally {
      sqlite.close();
    }
  });
});

function applyProfileMigrationsThroughV4(sqlite: BetterSqlite3.Database): void {
  const directory = fileURLToPath(new URL('../../migrations/profile/', import.meta.url));
  const files = readdirSync(directory)
    .filter((file) => /^00[1-4]_.*\.sql$/.test(file))
    .sort();
  for (const file of files) {
    sqlite.exec(readFileSync(new URL(`../../migrations/profile/${file}`, import.meta.url), 'utf8'));
  }
  sqlite.pragma('user_version = 4');
}
