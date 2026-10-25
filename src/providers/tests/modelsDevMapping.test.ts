import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '@ema-agent/storage';
import { ModelsDevCatalog, ProviderModels, Providers } from '../index.js';

const domesticModelId = 'Pro/moonshotai/Kimi-K2.5';
const internationalModelId = 'moonshotai/Kimi-K2.5';

function catalogModel(id: string) {
  return {
    id,
    name: 'Kimi K2.5',
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 262_144, output: 32_768 },
  };
}

describe('models.dev provider mapping', () => {
  let database: Database;
  let providers: Providers;
  let catalog: ModelsDevCatalog;
  let models: ProviderModels;

  beforeEach(async () => {
    database = new Database({ memory: true, kind: 'profile' });
    await database.migrate();
    providers = new Providers(database);
    catalog = new ModelsDevCatalog();
    catalog.loadFromJson({
      'siliconflow-cn': {
        api: 'https://api.siliconflow.cn/v1',
        models: { [domesticModelId]: catalogModel(domesticModelId) },
      },
      siliconflow: {
        api: 'https://api.siliconflow.com/v1',
        models: { [internationalModelId]: catalogModel(internationalModelId) },
      },
      deepseek: {
        api: 'https://api.deepseek.com',
        models: {
          'fixture-vision': catalogModel('fixture-vision'),
          'fixture-text': {
            ...catalogModel('fixture-text'),
            modalities: { input: ['text'], output: ['text'] },
          },
        },
      },
    });
    models = new ProviderModels(database, providers, catalog);
  });

  afterEach(() => {
    database.close();
  });

  it('exposes built-in DeepSeek Vision and imports only image-input models', () => {
    const config = providers.get('deepseek').capabilities.find(
      entry => entry.capability === 'vision',
    );
    expect(config?.modelsDevId).toBe('deepseek');
    expect(config?.activeProtocol).toBe('openai-llm');

    const rows = models.syncDevModels('deepseek', 'vision');

    expect(rows).toEqual([
      expect.objectContaining({ modelId: 'fixture-vision', inputImage: true, enabled: false }),
    ]);
  });

  it.each(['llm', 'vision'] as const)(
    'imports domestic model IDs for the built-in SiliconFlow %s endpoint',
    capability => {
      const config = providers.get('siliconflow-cn').capabilities.find(
        entry => entry.capability === capability,
      );
      expect(config?.protocols.find(
        entry => entry.protocol === config.activeProtocol,
      )?.baseUrl).toBe('https://api.siliconflow.cn/v1');

      const rows = models.syncDevModels('siliconflow-cn', capability);

      expect(rows.map(row => row.modelId)).toEqual([domesticModelId]);
    },
  );

  it('uses the domestic ID unchanged when the mapping explicitly selects China', () => {
    providers.update('siliconflow-cn', {
      capability: { capability: 'vision', modelsDevId: 'siliconflow-cn' },
    });

    expect(models.syncDevModels('siliconflow-cn', 'vision')).toEqual([
      expect.objectContaining({
        modelId: domesticModelId,
        name: 'Kimi K2.5',
        inputImage: true,
        contextWindow: 262_144,
        enabled: false,
      }),
    ]);
  });

  it('retains the supplied catalog mapping when creating a provider', () => {
    const provider = providers.create({
      id: 'custom-siliconflow',
      name: 'Custom SiliconFlow',
      authType: 'none',
      capability: {
        capability: 'vision',
        protocol: 'openai-llm',
        baseUrl: 'https://api.siliconflow.cn/v1',
        modelsDevId: 'siliconflow-cn',
      },
    });

    expect(provider.capabilities[0]?.modelsDevId).toBe('siliconflow-cn');
    expect(models.syncDevModels(provider.id, 'vision').map(row => row.modelId))
      .toEqual([domesticModelId]);
  });

  it('retains existing model rows when a catalog mapping changes', () => {
    providers.update('siliconflow-cn', {
      capability: { capability: 'vision', modelsDevId: 'siliconflow' },
    });
    models.syncDevModels('siliconflow-cn', 'vision');
    providers.update('siliconflow-cn', {
      capability: { capability: 'vision', modelsDevId: 'siliconflow-cn' },
    });

    const rows = models.syncDevModels('siliconflow-cn', 'vision');

    expect(rows.map(row => row.modelId).sort()).toEqual([
      domesticModelId,
      internationalModelId,
    ].sort());
  });

  it('clears a catalog association without deleting imported models', () => {
    models.syncDevModels('siliconflow-cn', 'vision');
    providers.update('siliconflow-cn', {
      capability: { capability: 'vision', modelsDevId: null },
    });

    expect(providers.get('siliconflow-cn').capabilities.find(
      entry => entry.capability === 'vision',
    )?.modelsDevId).toBeUndefined();
    expect(models.listByProvider('siliconflow-cn', 'vision')).toHaveLength(1);
    expect(() => models.syncDevModels('siliconflow-cn', 'vision'))
      .toThrow('未配置 models.dev ID');
  });

  it('reports an unknown catalog provider separately from a missing model', () => {
    providers.update('siliconflow-cn', {
      capability: { capability: 'vision', modelsDevId: 'unknown-catalog' },
    });
    expect(() => models.syncDevModels('siliconflow-cn', 'vision'))
      .toThrow('models.dev 目录中找不到供应商 unknown-catalog');
  });

  it('invalidates old health only when credentials or the active connection change', () => {
    providers.recordHealth('siliconflow-cn', 'vision', {
      capability: 'vision', status: 'failed', lastProbedAt: 1,
      latencyMs: 1, lastError: 'Old connection failed',
    });
    providers.update('siliconflow-cn', { name: 'My provider' });
    expect(providers.get('siliconflow-cn').health[0]?.status).toBe('failed');
    providers.update('siliconflow-cn', {
      capability: {
        capability: 'vision', protocol: 'openai-llm', baseUrl: 'https://fixture.test/v1',
      },
    });
    expect(providers.get('siliconflow-cn').health).toEqual([]);
    providers.recordHealth('siliconflow-cn', 'llm', {
      capability: 'llm', status: 'ok', lastProbedAt: 2, latencyMs: 1, lastError: null,
    });
    providers.update('siliconflow-cn', { key: 'new-fixture-key' });
    expect(providers.get('siliconflow-cn').health).toEqual([]);
  });
});
