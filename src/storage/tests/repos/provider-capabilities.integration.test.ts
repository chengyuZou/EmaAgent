// 测试 capability 级协议、地址和开关在 SQLite 中明确持久化。
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

  it('自定义 Provider 使用 null Definition 并保留每项能力的明确连接', () => {
    providers.save({
      id: 'custom-main',
      definitionId: null,
      displayName: 'Custom',
      enabled: true,
      capabilities: [
        { capability: 'llm', protocol: 'openai-responses-llm', baseUrl: 'https://llm.example/v1', enabled: true },
        { capability: 'embed', protocol: 'openai-embed', baseUrl: 'https://embed.example/v1', enabled: true },
        { capability: 'tts', protocol: 'openai-tts', baseUrl: 'https://tts.example/v1', enabled: false },
      ],
    });

    expect(providers.get('custom-main')).toMatchObject({
      definitionId: null,
      enabled: true,
      capabilities: [
        { capability: 'embed', baseUrl: 'https://embed.example/v1', enabled: true },
        { capability: 'llm', baseUrl: 'https://llm.example/v1', enabled: true },
        { capability: 'tts', baseUrl: 'https://tts.example/v1', enabled: false },
      ],
    });
  });

  it('保存全量能力配置时删除已经移除的能力', () => {
    providers.save({
      id: 'provider-1', definitionId: 'openai', displayName: 'OpenAI', enabled: true,
      capabilities: [
        { capability: 'llm', protocol: 'openai-llm', baseUrl: 'https://api.openai.com/v1', enabled: true },
        { capability: 'vision', protocol: 'openai-vision', baseUrl: 'https://api.openai.com/v1', enabled: true },
      ],
    });
    providers.save({
      id: 'provider-1', definitionId: 'openai', displayName: 'OpenAI', enabled: true,
      capabilities: [
        { capability: 'llm', protocol: 'openai-responses-llm', baseUrl: 'https://api.openai.com/v1', enabled: true },
      ],
    });

    expect(providers.get('provider-1')?.capabilities).toEqual([
      { capability: 'llm', protocol: 'openai-responses-llm', baseUrl: 'https://api.openai.com/v1', enabled: true },
    ]);
  });

  it('更新已有能力不删除模型事实，移除能力才级联清理', () => {
    providers.save({
      id: 'provider-1', definitionId: 'openai', displayName: 'OpenAI', enabled: true,
      capabilities: [
        { capability: 'llm', protocol: 'openai-llm', baseUrl: 'https://api.openai.com/v1', enabled: true },
        { capability: 'vision', protocol: 'openai-vision', baseUrl: 'https://api.openai.com/v1', enabled: true },
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
      id: 'provider-1', definitionId: 'openai', displayName: 'OpenAI Updated', enabled: true,
      capabilities: [
        { capability: 'llm', protocol: 'openai-responses-llm', baseUrl: 'https://api.openai.com/v1', enabled: true },
      ],
    });

    expect(models.get('provider-1', 'llm', 'gpt-test')).toBeDefined();
    expect(models.get('provider-1', 'vision', 'vision-test')).toBeUndefined();
  });
});
