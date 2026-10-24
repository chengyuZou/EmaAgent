import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { Database, SettingsRepo } from '@ema-agent/storage';
import { ModelBindings, ModelsDevCatalog, ProviderModels, Providers } from '@ema-agent/providers';
import { SettingsStore } from '@ema-agent/settings';
import { UsageRecorder } from '@ema-agent/usage';
import { openNarrative } from '../src/composition/narrative.js';

vi.mock('@ema-agent/llm', async () => import('../../../src/llm/languageModel.js'));

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0).reverse()) db.close();
  vi.unstubAllGlobals();
});

it('records both isolated non-streaming requests with an 8192 budget when the catalog allows 128000', async () => {
  const profile = new Database({ memory: true, kind: 'profile' });
  const data = new Database({ memory: true, kind: 'data' });
  const narrative = new Database({ memory: true, kind: 'narrative' });
  databases.push(profile, data, narrative);
  profile.migrate();
  data.migrate();
  narrative.sqlite.exec(readFileSync(
    new URL('../../../src/storage/migrations/narrative/narrative.sql', import.meta.url),
    'utf8',
  ));
  data.sqlite.exec(`
    INSERT INTO sessions (id, title, cwd, created_at, updated_at)
    VALUES ('session', 'Fixture', '.', 1, 1);
    INSERT INTO turns (id, session_id, status, created_at)
    VALUES ('turn', 'session', 'running', 1);
  `);
  const providers = new Providers(profile);
  const models = new ProviderModels(profile, providers, new ModelsDevCatalog());
  const bindings = new ModelBindings(profile, models);
  providers.create({
    id: 'fixture', name: 'Fixture', authType: 'bearer', key: 'fixture-key',
    capability: { capability: 'llm', protocol: 'anthropic-llm', baseUrl: 'https://fixture.test' },
  });
  providers.update('fixture', {
    capability: { capability: 'embed', protocol: 'openai-embed', baseUrl: 'https://fixture.test/v1' },
  });
  providers.update('fixture', {
    capability: { capability: 'rerank', protocol: 'cohere-rerank', baseUrl: 'https://fixture.test/v1' },
  });
  models.save({
    providerId: 'fixture', modelId: 'large-output-model', capability: 'llm',
    contextWindow: 262144, maxOutput: 128000, inputImage: false,
    toolCall: true, reasoning: false, temperature: true,
  });
  models.save({ providerId: 'fixture', modelId: 'embed-model', capability: 'embed', dim: 1024 });
  models.save({ providerId: 'fixture', modelId: 'rerank-model', capability: 'rerank', maxChunks: null });
  bindings.set({ module: 'narrative-llm', providerId: 'fixture', modelId: 'large-output-model' });
  bindings.set({ module: 'narrative-embed', providerId: 'fixture', modelId: 'embed-model' });
  bindings.set({ module: 'narrative-rerank', providerId: 'fixture', modelId: 'rerank-model' });

  const requests: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = await request.json() as Record<string, unknown>;
    requests.push({ url: request.url, body });
    if (request.url.endsWith('/v1/messages')) {
      return Response.json({
        id: 'fixture-message', type: 'message', role: 'assistant', model: 'large-output-model',
        content: [{ type: 'text', text: JSON.stringify(body.system
          ? { timelines: ['3rd_Loop'] }
          : { high_level_keywords: ['story'], low_level_keywords: ['character'] }) }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20 },
      });
    }
    if (request.url.endsWith('/embeddings')) {
      return Response.json({
        data: (body.input as string[]).map((_, index) => ({
          index, embedding: [1, ...Array<number>(1023).fill(0)],
        })),
        usage: { prompt_tokens: 3, total_tokens: 3 },
      });
    }
    throw new Error(`Unexpected test request: ${request.url}`);
  }));
  const search = openNarrative(
    narrative, providers, models, bindings,
    new SettingsStore(new SettingsRepo(profile.sqlite)), new UsageRecorder(data),
  ).resolveSearch('session', 'turn');
  expect(search).toBeDefined();
  await search!('Fixture story', 'hybrid', new AbortController().signal);

  const llmRequests = requests.filter(request => request.url.endsWith('/v1/messages'));
  expect(llmRequests).toHaveLength(2);
  for (const request of llmRequests) {
    expect(request.body).toMatchObject({ max_tokens: 8192, stream: false });
  }
  const route = llmRequests.find(request => request.body.system);
  const extraction = llmRequests.find(request => !request.body.system);
  expect(route?.body.messages).toEqual([{ role: 'user', content: 'Fixture story' }]);
  expect(JSON.stringify(route?.body.system)).toContain('剧情摘要');
  expect(JSON.stringify(extraction?.body.messages)).toContain('User Query: Fixture story');
  expect(JSON.stringify(extraction?.body.messages)).not.toContain('剧情摘要');
  expect(data.sqlite.prepare("SELECT status, output_tokens FROM usage_records WHERE capability = 'llm'").all())
    .toEqual([
      { status: 'completed', output_tokens: 20 },
      { status: 'completed', output_tokens: 20 },
    ]);
});
