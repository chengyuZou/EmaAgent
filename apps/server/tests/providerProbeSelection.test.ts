import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '@ema-agent/storage';
import { ModelsDevCatalog, ProviderModels, Providers } from '@ema-agent/providers';
import { providerHealthRoute } from '../src/routes/providers/health.js';

vi.mock('@ema-agent/llm', async () => import('../../../src/llm/languageModel.js'));

describe('provider probe model selection', () => {
  let database: Database;
  let providers: Providers;
  let providerModels: ProviderModels;
  let modelCatalog: ModelsDevCatalog;
  let fetchedModels: string[];

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    providers = new Providers(database);
    modelCatalog = new ModelsDevCatalog();
    providerModels = new ProviderModels(database, providers, modelCatalog);
    providers.create({
      id: 'fixture',
      name: 'Fixture',
      authType: 'bearer',
      key: 'fixture-key',
      capability: {
        capability: 'vision',
        protocol: 'openai-llm',
        baseUrl: 'https://fixture.test/v1',
      },
    });
    fetchedModels = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { model: string };
      fetchedModels.push(body.model);
      return new Response([
        `data: ${JSON.stringify({
          id: 'fixture-response',
          object: 'chat.completion.chunk',
          created: 0,
          model: body.model,
          choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}`,
        '',
        'data: [DONE]',
        '',
        '',
      ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } });
    }));
  });

  afterEach(() => {
    database.close();
    vi.unstubAllGlobals();
  });

  function saveModel(modelId: string) {
    providerModels.save({
      providerId: 'fixture',
      capability: 'vision',
      modelId,
      contextWindow: 8192,
      maxOutput: 1024,
      inputImage: true,
      toolCall: false,
      reasoning: false,
      temperature: true,
    });
  }

  function probe(modelId?: string) {
    return providerHealthRoute({
      providers,
      providerModels,
      modelCatalog,
      notifyProviderHealthChanged: vi.fn(),
    }).request('/fixture/probe/vision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(modelId === undefined ? {} : { modelId }),
    });
  }

  it('probes the first enabled model instead of a preceding disabled model', async () => {
    saveModel('A/Disabled');
    saveModel('Z/Enabled');
    providerModels.setEnabled('fixture', 'vision', 'A/Disabled', false);
    providerModels.setEnabled('fixture', 'vision', 'Z/Enabled', true);

    const response = await probe();

    expect(await response.json()).toMatchObject({ ok: true });
    expect(fetchedModels).toEqual(['Z/Enabled']);
  });

  it('falls back to the first model when every model is disabled', async () => {
    saveModel('A/Disabled');
    saveModel('Z/Disabled');
    providerModels.setEnabled('fixture', 'vision', 'A/Disabled', false);
    providerModels.setEnabled('fixture', 'vision', 'Z/Disabled', false);

    expect(await (await probe()).json()).toMatchObject({ ok: true });
    expect(fetchedModels).toEqual(['A/Disabled']);
  });

  it('reports an empty manual model pool without making a request', async () => {
    expect(await (await probe()).json()).toMatchObject({ error: 'no_model' });
    expect(fetchedModels).toEqual([]);
  });

  it('uses an explicit model ID unchanged, including its provider prefix', async () => {
    saveModel('A/Disabled');
    saveModel('Pro/moonshotai/Kimi-K2.5');
    providerModels.setEnabled('fixture', 'vision', 'A/Disabled', false);

    const response = await probe('Pro/moonshotai/Kimi-K2.5');

    expect(await response.json()).toMatchObject({ ok: true });
    expect(fetchedModels).toEqual(['Pro/moonshotai/Kimi-K2.5']);
  });
});
