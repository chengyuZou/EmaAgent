// 测试模型绑定的合法模块集合、确定查询和事务原子性。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Database,
  ModelBindingsRepo,
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
    bindings.upsert({ module: 'memory', providerConfigId: 'provider-1', model: 'old-model' });

    bindings.setSingle({ module: 'memory', providerConfigId: 'provider-1', model: 'new-model' });

    expect(bindings.listByModule('memory').map((r) => r.model)).toEqual(['new-model']);
  });

  it('setSingle 中途 upsert 失败时旧绑定保留（事务回滚，不丢配置）', () => {
    const bindings = new ModelBindingsRepo(database.sqlite);
    bindings.upsert({ module: 'memory', providerConfigId: 'provider-1', model: 'old-model' });

    // upsert 失败场景：provider_config_id 的 FK 不存在 -> 违反外键约束。
    // setSingle 先 deleteAll（删掉 old-model），再 upsert（FK 失败抛错）；
    // 事务必须回滚把 old-model 还回来，否则模块瞬间失去全部绑定。
    expect(() =>
      bindings.setSingle({ module: 'memory', providerConfigId: 'missing-provider', model: 'new-model' }),
    ).toThrow(/FOREIGN KEY constraint failed/);

    expect(bindings.listByModule('memory').map((r) => r.model)).toEqual(['old-model']);
  });

  it('当前 Schema 拒绝已经退役的模型绑定模块', () => {
    const insert = database.sqlite.prepare(`
      INSERT INTO model_bindings (module, provider_config_id, model)
      VALUES (?, 'provider-1', 'model-a')
    `);

    expect(() => insert.run('emotion')).toThrow(/CHECK constraint failed/);
    expect(() => insert.run('router')).toThrow(/CHECK constraint failed/);
    expect(() => insert.run('plan-parse')).toThrow(/CHECK constraint failed/);
    expect(() => insert.run('vision')).not.toThrow();
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
    bindings.upsert({ module: 'title', providerConfigId: 'p-zeta', model: 'z-model' });
    bindings.upsert({ module: 'title', providerConfigId: 'p-alpha', model: 'm-model' });
    bindings.upsert({ module: 'title', providerConfigId: 'p-alpha', model: 'a-model' });

    const first = bindings.get('title');
    expect(first?.providerConfigId).toBe('p-alpha');
    expect(first?.model).toBe('a-model');
  });

  it('listByModule() 按 (provider_config_id, model) 稳定排序', () => {
    const bindings = new ModelBindingsRepo(database.sqlite);
    bindings.upsert({ module: 'title', providerConfigId: 'p-zeta', model: 'z-model' });
    bindings.upsert({ module: 'title', providerConfigId: 'p-alpha', model: 'm-model' });
    bindings.upsert({ module: 'title', providerConfigId: 'p-alpha', model: 'a-model' });

    expect(bindings.listByModule('title').map((r) => [r.providerConfigId, r.model]))
      .toEqual([
        ['p-alpha', 'a-model'],
        ['p-alpha', 'm-model'],
        ['p-zeta', 'z-model'],
      ]);
  });
});
