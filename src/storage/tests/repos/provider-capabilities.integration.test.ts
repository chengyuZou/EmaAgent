// 测试 capability 级协议、激活指针和地址在 SQLite 中明确持久化。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, ProviderModelsRepo, ProvidersRepo } from '../../index.js';
import { createTestCredentialFacade } from '../helpers/test-credential-facade.js';

describe('Provider 能力配置', () => {
  let database: Database;
  let providers: ProvidersRepo;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    providers = new ProvidersRepo(database.sqlite, createTestCredentialFacade());
  });

  afterEach(() => database.close());

  it('自定义 Provider 使用 null providerId 并保留每项能力的明确连接', () => {
    providers.save({
      id: 'custom-main',
      providerId: null,
      displayName: 'Custom',
      enabled: true,
      capabilities: [
        { capability: 'llm', activeProtocol: 'openai-responses-llm', protocols: [{ protocol: 'openai-responses-llm', baseUrl: 'https://llm.example/v1' }] },
        { capability: 'embed', activeProtocol: 'openai-embed', protocols: [{ protocol: 'openai-embed', baseUrl: 'https://embed.example/v1' }] },
        { capability: 'tts', protocols: [{ protocol: 'openai-tts', baseUrl: 'https://tts.example/v1' }] },
      ],
    });

    expect(providers.get('custom-main')).toMatchObject({
      providerId: null,
      enabled: true,
      capabilities: [
        { capability: 'embed', activeProtocol: 'openai-embed' },
        { capability: 'llm', activeProtocol: 'openai-responses-llm' },
        // tts 无激活协议 = 停用，但地址保留
        { capability: 'tts', protocols: [{ protocol: 'openai-tts', baseUrl: 'https://tts.example/v1' }] },
      ],
    });
  });

  it('同一能力可配多档协议，切换激活不丢另一档的地址', () => {
    const protocols = [
      { protocol: 'openai-llm', baseUrl: 'https://api.deepseek.com' },
      { protocol: 'anthropic-llm', baseUrl: 'https://api.deepseek.com/anthropic' },
    ] as const;
    providers.save({
      id: 'provider-1', providerId: 'deepseek', displayName: 'DeepSeek', enabled: true,
      capabilities: [{ capability: 'llm', activeProtocol: 'openai-llm', protocols: [...protocols] }],
    });

    providers.save({
      id: 'provider-1', providerId: 'deepseek', displayName: 'DeepSeek', enabled: true,
      capabilities: [{ capability: 'llm', activeProtocol: 'anthropic-llm', protocols: [...protocols] }],
    });

    const config = providers.get('provider-1');
    expect(config?.capabilities[0]?.activeProtocol).toBe('anthropic-llm');
    // repo 按 protocol 字典序返回（anthropic-llm 在前）
    expect(config?.capabilities[0]?.protocols).toEqual([protocols[1], protocols[0]]);
  });

  it('保存全量能力配置时删除已经移除的能力', () => {
    providers.save({
      id: 'provider-1', providerId: 'openai', displayName: 'OpenAI', enabled: true,
      capabilities: [
        { capability: 'llm', activeProtocol: 'openai-llm', protocols: [{ protocol: 'openai-llm', baseUrl: 'https://api.openai.com/v1' }] },
        { capability: 'vision', activeProtocol: 'openai-vision', protocols: [{ protocol: 'openai-vision', baseUrl: 'https://api.openai.com/v1' }] },
      ],
    });
    providers.save({
      id: 'provider-1', providerId: 'openai', displayName: 'OpenAI', enabled: true,
      capabilities: [
        { capability: 'llm', activeProtocol: 'openai-responses-llm', protocols: [{ protocol: 'openai-responses-llm', baseUrl: 'https://api.openai.com/v1' }] },
      ],
    });

    expect(providers.get('provider-1')?.capabilities).toEqual([
      {
        capability: 'llm',
        activeProtocol: 'openai-responses-llm',
        protocols: [{ protocol: 'openai-responses-llm', baseUrl: 'https://api.openai.com/v1' }],
      },
    ]);
  });

  it('更新已有能力不删除模型事实，移除能力才级联清理', () => {
    providers.save({
      id: 'provider-1', providerId: 'openai', displayName: 'OpenAI', enabled: true,
      capabilities: [
        { capability: 'llm', activeProtocol: 'openai-llm', protocols: [{ protocol: 'openai-llm', baseUrl: 'https://api.openai.com/v1' }] },
        { capability: 'vision', activeProtocol: 'openai-vision', protocols: [{ protocol: 'openai-vision', baseUrl: 'https://api.openai.com/v1' }] },
      ],
    });
    const models = new ProviderModelsRepo(database.sqlite);
    models.save({
      providerConfigId: 'provider-1', capability: 'llm', model: 'gpt-test',
      contextWindow: 32_000, maxOutput: null, toolCall: null,
      reasoning: null, temperature: null, inputImage: null,
    });
    models.save({
      providerConfigId: 'provider-1', capability: 'vision', model: 'vision-test',
    });

    providers.save({
      id: 'provider-1', providerId: 'openai', displayName: 'OpenAI Updated', enabled: true,
      capabilities: [
        { capability: 'llm', activeProtocol: 'openai-responses-llm', protocols: [{ protocol: 'openai-responses-llm', baseUrl: 'https://api.openai.com/v1' }] },
      ],
    });

    expect(models.get('provider-1', 'llm', 'gpt-test')).toBeDefined();
    expect(models.get('provider-1', 'vision', 'vision-test')).toBeUndefined();
  });
});
