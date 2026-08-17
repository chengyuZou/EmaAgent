// 测试 Provider 行、能力配置、按能力隔离的 key 与按能力健康在 SQLite 中明确持久化。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, ProviderModelsRepo, ProvidersRepo } from '../../index.js';

describe('Provider 能力配置', () => {
  let database: Database;
  let providers: ProvidersRepo;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    providers = new ProvidersRepo(database.sqlite);
  });

  afterEach(() => database.close());

  it('002 种子：19 个内置 provider 含协议档与离线建议模型，enabled=0', () => {
    expect(providers.list()).toHaveLength(19);
    expect(providers.get('deepseek')).toMatchObject({
      name: 'DeepSeek', authType: 'bearer', enabled: false,
      capabilities: [{
        capability: 'llm',
        activeProtocol: 'openai-llm',
        modelsDevId: 'deepseek',
        protocols: [
          { protocol: 'anthropic-llm', baseUrl: 'https://api.deepseek.com/anthropic' },
          { protocol: 'openai-llm', baseUrl: 'https://api.deepseek.com' },
        ],
      }],
    });
    expect(providers.get('ollama')?.authType).toBe('none');

    const models = new ProviderModelsRepo(database.sqlite);
    expect(models.get('openai', 'embed', 'text-embedding-3-small')).toMatchObject({ dim: 1_536 });
    // vision 与 LLM 同参数集：上下文窗口必填
    expect(models.get('ollama', 'vision', 'llava')).toMatchObject({ contextWindow: 4_096 });
  });

  it('自建 Provider 保留每项能力的明确连接与图标缺省', () => {
    providers.save({
      id: 'custom-main',
      name: 'Custom',
      authType: 'bearer',
      enabled: true,
      capabilities: [
        { capability: 'llm', activeProtocol: 'openai-responses-llm', protocols: [{ protocol: 'openai-responses-llm', baseUrl: 'https://llm.example/v1' }] },
        { capability: 'embed', activeProtocol: 'openai-embed', protocols: [{ protocol: 'openai-embed', baseUrl: 'https://embed.example/v1' }] },
        { capability: 'tts', protocols: [{ protocol: 'openai-tts', baseUrl: 'https://tts.example/v1' }] },
      ],
    });

    expect(providers.get('custom-main')).toMatchObject({
      name: 'Custom',
      authType: 'bearer',
      enabled: true,
      capabilities: [
        { capability: 'embed', activeProtocol: 'openai-embed' },
        { capability: 'llm', activeProtocol: 'openai-responses-llm' },
        // tts 无激活协议 = 停用，但地址保留
        { capability: 'tts', protocols: [{ protocol: 'openai-tts', baseUrl: 'https://tts.example/v1' }] },
      ],
    });
    expect(providers.get('custom-main')?.iconId).toBeUndefined();
    expect(providers.get('custom-main')?.health).toEqual([]);
  });

  it('同一能力可配多档协议，切换激活不丢另一档的地址', () => {
    const protocols = [
      { protocol: 'openai-llm', baseUrl: 'https://api.deepseek.com' },
      { protocol: 'anthropic-llm', baseUrl: 'https://api.deepseek.com/anthropic' },
    ] as const;
    providers.save({
      id: 'deepseek', name: 'DeepSeek', iconId: 'deepseek', authType: 'bearer', enabled: true,
      capabilities: [{ capability: 'llm', activeProtocol: 'openai-llm', protocols: [...protocols] }],
    });

    providers.save({
      id: 'deepseek', name: 'DeepSeek', iconId: 'deepseek', authType: 'bearer', enabled: true,
      capabilities: [{ capability: 'llm', activeProtocol: 'anthropic-llm', protocols: [...protocols] }],
    });

    const provider = providers.get('deepseek');
    expect(provider?.capabilities[0]?.activeProtocol).toBe('anthropic-llm');
    // repo 按 protocol 字典序返回（anthropic-llm 在前）
    expect(provider?.capabilities[0]?.protocols).toEqual([protocols[1], protocols[0]]);
  });

  it('保存全量能力配置时删除已经移除的能力与其 key', () => {
    providers.save({
      id: 'openai', name: 'OpenAI', authType: 'bearer', enabled: true,
      capabilities: [
        { capability: 'llm', activeProtocol: 'openai-llm', protocols: [{ protocol: 'openai-llm', baseUrl: 'https://api.openai.com/v1' }] },
        { capability: 'vision', activeProtocol: 'openai-vision', protocols: [{ protocol: 'openai-vision', baseUrl: 'https://api.openai.com/v1' }] },
      ],
      newKeys: [{ id: 'key-vision', capability: 'vision', keyValue: 'sk-vision' }],
    });
    expect(providers.listKeys('openai', 'vision')).toHaveLength(1);

    providers.save({
      id: 'openai', name: 'OpenAI', authType: 'bearer', enabled: true,
      capabilities: [
        { capability: 'llm', activeProtocol: 'openai-responses-llm', protocols: [{ protocol: 'openai-responses-llm', baseUrl: 'https://api.openai.com/v1' }] },
      ],
    });

    expect(providers.get('openai')?.capabilities).toEqual([
      {
        capability: 'llm',
        activeProtocol: 'openai-responses-llm',
        protocols: [{ protocol: 'openai-responses-llm', baseUrl: 'https://api.openai.com/v1' }],
      },
    ]);
    expect(providers.listKeys('openai', 'vision')).toEqual([]);
  });

  it('key 按能力隔离：active 指针各拨各的，latestKeyValue 取全 provider 最近一把', () => {
    providers.save({
      id: 'siliconflow', name: 'SiliconFlow', authType: 'bearer', enabled: true,
      capabilities: [
        { capability: 'llm', activeProtocol: 'openai-llm', protocols: [{ protocol: 'openai-llm', baseUrl: 'https://api.siliconflow.cn/v1' }] },
        { capability: 'tts', activeProtocol: 'openai-tts', protocols: [{ protocol: 'openai-tts', baseUrl: 'https://api.siliconflow.cn/v1' }] },
      ],
      newKeys: [{ id: 'key-llm-1', capability: 'llm', keyValue: 'sk-llm-a' }],
    });
    const base = Date.now();
    providers.addKey({
      id: 'key-llm-2', providerId: 'siliconflow', capability: 'llm',
      keyValue: 'sk-llm-b', createdAt: base + 1,
    });
    providers.addKey({
      id: 'key-tts-1', providerId: 'siliconflow', capability: 'tts',
      keyValue: 'sk-tts-a', createdAt: base + 2,
    });

    // TTS 的 key 不影响 LLM 的 active 指针
    expect(providers.get('siliconflow')?.capabilities).toEqual([
      { capability: 'llm', activeProtocol: 'openai-llm', activeKeyId: 'key-llm-2',
        protocols: [{ protocol: 'openai-llm', baseUrl: 'https://api.siliconflow.cn/v1' }] },
      { capability: 'tts', activeProtocol: 'openai-tts', activeKeyId: 'key-tts-1',
        protocols: [{ protocol: 'openai-tts', baseUrl: 'https://api.siliconflow.cn/v1' }] },
    ]);

    providers.setActiveKey('siliconflow', 'llm', 'key-llm-1');
    expect(providers.get('siliconflow')?.capabilities[0]?.activeKeyId).toBe('key-llm-1');

    expect(providers.latestKeyValue('siliconflow')).toBe('sk-tts-a');
    expect(providers.listKeys('siliconflow', 'llm').map((key) => key.id))
      .toEqual(['key-llm-2', 'key-llm-1']);
  });

  it('健康按能力独立记录并随 Provider 一并读出', () => {
    providers.save({
      id: 'deepseek', name: 'DeepSeek', authType: 'bearer', enabled: true,
      capabilities: [{ capability: 'llm', activeProtocol: 'openai-llm', protocols: [{ protocol: 'openai-llm', baseUrl: 'https://api.deepseek.com' }] }],
    });
    providers.recordHealth('deepseek', 'llm', {
      capability: 'llm', status: 'ok', lastProbedAt: 1_000, latencyMs: 42, lastError: null,
    });

    expect(providers.get('deepseek')?.health).toEqual([
      { capability: 'llm', status: 'ok', lastProbedAt: 1_000, latencyMs: 42, lastError: null },
    ]);

    providers.recordHealth('deepseek', 'llm', {
      capability: 'llm', status: 'failed', lastProbedAt: 2_000, latencyMs: null, lastError: 'timeout',
    });
    expect(providers.get('deepseek')?.health).toEqual([
      { capability: 'llm', status: 'failed', lastProbedAt: 2_000, latencyMs: null, lastError: 'timeout' },
    ]);
  });

  it('更新已有能力不删除模型事实，移除能力才级联清理', () => {
    providers.save({
      id: 'openai', name: 'OpenAI', authType: 'bearer', enabled: true,
      capabilities: [
        { capability: 'llm', activeProtocol: 'openai-llm', protocols: [{ protocol: 'openai-llm', baseUrl: 'https://api.openai.com/v1' }] },
        { capability: 'vision', activeProtocol: 'openai-vision', protocols: [{ protocol: 'openai-vision', baseUrl: 'https://api.openai.com/v1' }] },
      ],
    });
    const models = new ProviderModelsRepo(database.sqlite);
    models.save({
      providerId: 'openai', capability: 'llm', modelId: 'gpt-test',
      contextWindow: 32_000, maxOutput: null, toolCall: null,
      reasoning: null, temperature: null, inputImage: null,
    });
    models.save({
      providerId: 'openai', capability: 'vision', modelId: 'vision-test',
      contextWindow: 128_000, maxOutput: null, toolCall: null,
      reasoning: null, temperature: null, inputImage: null,
    });

    providers.save({
      id: 'openai', name: 'OpenAI Updated', authType: 'bearer', enabled: true,
      capabilities: [
        { capability: 'llm', activeProtocol: 'openai-responses-llm', protocols: [{ protocol: 'openai-responses-llm', baseUrl: 'https://api.openai.com/v1' }] },
      ],
    });

    expect(models.get('openai', 'llm', 'gpt-test')).toBeDefined();
    expect(models.get('openai', 'vision', 'vision-test')).toBeUndefined();
  });
});
