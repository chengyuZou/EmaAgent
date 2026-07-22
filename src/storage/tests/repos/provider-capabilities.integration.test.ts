// 测试 Provider 能力级协议、地址、版本和开关在 SQLite 中独立持久化并稳定查询。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, ProvidersRepo } from '../../index.js';
import { createTestCredentialFacade } from '../helpers/test-credential-facade.js';

describe('Provider 能力级配置', () => {
  let database: Database;
  let providers: ProvidersRepo;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    providers = new ProvidersRepo(database.sqlite, createTestCredentialFacade());
  });

  afterEach(() => database.close());

  it('物理删除已经由能力表取代的 Provider 顶层列', () => {
    const columns = database.sqlite.prepare('PRAGMA table_info(provider_configs)')
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toEqual(expect.arrayContaining([
      'base_url',
      'config_json',
      'capabilities_json',
    ]));
  });

  it('同一 Provider 的 LLM、Embed 和 TTS 保留各自协议与地址', () => {
    providers.upsert({
      id: 'openai-main',
      definitionId: 'openai',
      displayName: 'OpenAI',
      apiKey: 'secret',
      capabilities: [
        {
          capability: 'llm',
          protocol: 'openai-responses-llm',
          baseUrl: 'https://gateway.example/v1',
        },
        {
          capability: 'embed',
          protocol: 'openai-embed',
          baseUrl: 'https://embed.example/v1',
          embeddingRevision: '2026-07',
        },
        {
          capability: 'tts',
          protocol: 'openai-tts',
          baseUrl: null,
        },
      ],
    });

    expect(providers.get('openai-main')?.capabilities).toEqual([
      expect.objectContaining({
        capability: 'embed',
        protocol: 'openai-embed',
        base_url: 'https://embed.example/v1',
        embedding_revision: '2026-07',
      }),
      expect.objectContaining({
        capability: 'llm',
        protocol: 'openai-responses-llm',
        base_url: 'https://gateway.example/v1',
      }),
      expect.objectContaining({
        capability: 'tts',
        protocol: 'openai-tts',
        base_url: null,
      }),
    ]);
  });

  it('关闭单项能力不会关闭 Provider 或其他能力', () => {
    providers.upsert({
      id: 'multi',
      definitionId: 'siliconflow',
      displayName: 'SiliconFlow',
      capabilities: [
        { capability: 'llm' },
        { capability: 'vision', enabled: false },
      ],
    });

    expect(providers.listByCapability('llm').map((row) => row.id)).toEqual(['multi']);
    expect(providers.listByCapability('vision')).toEqual([]);
    expect(providers.get('multi')?.enabled).toBe(1);
  });

  it('更新一项能力不会覆盖其他能力配置', () => {
    providers.upsert({
      id: 'multi',
      definitionId: 'siliconflow',
      displayName: 'SiliconFlow',
      capabilities: [
        { capability: 'llm', baseUrl: 'https://llm.example/v1' },
        { capability: 'stt', baseUrl: 'https://stt.example/v1' },
      ],
    });

    providers.upsertCapability('multi', {
      capability: 'llm',
      protocol: 'openai-responses-llm',
      baseUrl: 'https://new-llm.example/v1',
    });

    const capabilities = providers.get('multi')?.capabilities ?? [];
    expect(capabilities.find((item) => item.capability === 'llm')).toMatchObject({
      protocol: 'openai-responses-llm',
      base_url: 'https://new-llm.example/v1',
    });
    expect(capabilities.find((item) => item.capability === 'stt')).toMatchObject({
      base_url: 'https://stt.example/v1',
    });
  });
});
