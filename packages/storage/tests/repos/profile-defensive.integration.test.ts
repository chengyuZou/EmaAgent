import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asCharacterCardId } from '@ema-agent/contracts';
import {
  CharacterCardsRepo,
  Database,
  KbRegistryRepo,
  Live2DModelsRepo,
  MarketSourcesRepo,
  ModelBindingsRepo,
  ProvidersRepo,
} from '../../src/index.js';

describe('profile 仓储防御性业务', () => {
  let database: Database;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
  });

  afterEach(() => {
    database.close();
  });

  it('激活不存在的角色卡时保留原来的活跃角色卡', () => {
    const repo = new CharacterCardsRepo(database.sqlite);
    const activeId = asCharacterCardId('active-card');
    repo.insert({
      id: activeId,
      name: 'Active',
      systemPrompt: 'active prompt',
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
    });

    const activated = repo.activate(asCharacterCardId('missing-card'), 2);

    expect(activated).toBe(false);
    expect(repo.findActive()?.id).toBe(activeId);
    expect(repo.findActive()?.updated_at).toBe(1);
  });

  it('激活不存在的知识库时保留原来的活跃知识库', () => {
    const repo = new KbRegistryRepo(database.sqlite);
    repo.insert({ id: 'active-kb', name: 'Active KB', path: 'D:/kb/active' });
    expect(repo.setActive('active-kb')).toBe(true);

    const activated = repo.setActive('missing-kb');

    expect(activated).toBe(false);
    expect(repo.getActive()?.id).toBe('active-kb');
  });

  it('市场源删除区分已删除、不存在和内置保护', () => {
    const repo = new MarketSourcesRepo(database.sqlite);
    const base = {
      kind: 'mcp',
      type: 'json-index',
      label: 'Source',
      config: '{}',
      enabled: 1,
      sort_order: 0,
      created_at: 1,
    };
    repo.insert({ ...base, id: 'builtin-source', builtin: 1 });
    repo.insert({ ...base, id: 'user-source', builtin: 0 });

    expect(repo.deleteById('builtin-source')).toBe('builtin_protected');
    expect(repo.findById('builtin-source')).not.toBeNull();
    expect(repo.deleteById('user-source')).toBe('deleted');
    expect(repo.deleteById('missing-source')).toBe('not_found');
  });

  it('角色卡和 Live2D 模型删除都明确报告内置保护', () => {
    const cards = new CharacterCardsRepo(database.sqlite);
    const builtinCardId = asCharacterCardId('builtin-card');
    const userCardId = asCharacterCardId('user-card');
    cards.insert({
      id: builtinCardId,
      name: 'Builtin',
      systemPrompt: 'builtin prompt',
      isBuiltin: true,
      createdAt: 1,
      updatedAt: 1,
    });
    cards.insert({
      id: userCardId,
      name: 'User',
      systemPrompt: 'user prompt',
      createdAt: 1,
      updatedAt: 1,
    });

    const models = new Live2DModelsRepo(database.sqlite);
    models.insert({
      id: 'builtin-model',
      name: 'Builtin',
      format: 'live2d',
      storage_path: 'builtin/model.json',
      params_json: '{}',
      is_builtin: 1,
      created_at: 1,
      updated_at: 1,
    });
    models.insert({
      id: 'user-model',
      name: 'User',
      format: 'vrm',
      storage_path: 'user/model.vrm',
      params_json: '{}',
      is_builtin: 0,
      created_at: 1,
      updated_at: 1,
    });

    expect(cards.delete(builtinCardId)).toBe('builtin_protected');
    expect(cards.delete(userCardId)).toBe('deleted');
    expect(cards.delete(asCharacterCardId('missing-card'))).toBe('not_found');
    expect(models.delete('builtin-model')).toBe('builtin_protected');
    expect(models.delete('user-model')).toBe('deleted');
    expect(models.delete('missing-model')).toBe('not_found');
  });

  it('删除 Provider 前可以确定性列出全部业务绑定', () => {
    const providers = new ProvidersRepo(database.sqlite);
    providers.upsert({
      id: 'provider-1',
      definitionId: 'siliconflow',
      displayName: 'Provider',
      apiKey: 'secret',
      capabilities: ['llm', 'embed'],
    });
    const bindings = new ModelBindingsRepo(database.sqlite);
    bindings.upsert({ module: 'lightrag-llm', providerConfigId: 'provider-1', model: 'z-model' });
    bindings.upsert({ module: 'emotion', providerConfigId: 'provider-1', model: 'a-model' });

    expect(bindings.listByProviderConfig('provider-1').map((binding) => binding.module))
      .toEqual(['emotion', 'lightrag-llm']);
    expect(() => providers.delete('provider-1')).toThrow(/FOREIGN KEY constraint failed/);
  });
});
