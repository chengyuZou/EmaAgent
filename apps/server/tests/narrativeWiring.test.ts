import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Database, SettingsRepo } from '@ema-agent/storage';
import { ModelBindings, ModelsDevCatalog, ProviderModels, Providers } from '@ema-agent/providers';
import { SettingsStore } from '@ema-agent/settings';
import { openNarrative } from '../src/composition/narrative.js';
import { narrativeQueryModeSetting } from '../src/settings/narrativeSetting.js';

let server: Server;
let profile: Database;
let narrative: Database;
let bindings: ModelBindings;
let settings: SettingsStore;
let host: ReturnType<typeof openNarrative>;
interface ModelRequest {
  model: string;
  max_tokens?: number;
  system?: unknown;
  input?: string[];
}
let requests: Array<{ url: string; body: ModelRequest }>;
const vector = Array<number>(1024).fill(0);
vector[0] = 1;

beforeEach(async () => {
  requests = [];
  // 只监听本机, 不读取用户凭据或调用外部模型服务.
  server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text) as ModelRequest;
    requests.push({ url: request.url!, body });
    if (request.url!.endsWith('/embeddings')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        data: body.input!.map((_, index) => ({ index, embedding: vector })),
      }));
      return;
    }
    const result = body.system
      ? '{"1st_Loop":"剧情问题"}'
      : '{"high_level_keywords":["事件"],"low_level_keywords":["人物"]}';
    const events = [
      { type: 'message_start', message: {
        id: 'local', type: 'message', role: 'assistant', model: body.model, content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
      } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: result } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    response.setHeader('Content-Type', 'text/event-stream');
    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('local server did not bind');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  profile = new Database({ memory: true, kind: 'profile' });
  profile.migrate();
  narrative = new Database({ memory: true, kind: 'narrative' });
  for (const name of ['narrative.sql', 'narrative-cache.sql']) {
    narrative.sqlite.exec(readFileSync(
      new URL(`../../../src/storage/migrations/narrative/${name}`, import.meta.url), 'utf8',
    ));
  }
  narrative.sqlite.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?)')
    .run('1st_Loop', 'source', '真实 SQLite 剧情正文', Buffer.from(Float32Array.from(vector).buffer));
  const providers = new Providers(profile);
  providers.create({
    id: 'local-llm', name: 'Local LLM', authType: 'bearer', key: 'test-only',
    capability: { capability: 'llm', protocol: 'anthropic-llm', baseUrl },
  });
  providers.create({
    id: 'local-embed', name: 'Local Embed', authType: 'none',
    capability: { capability: 'embed', protocol: 'openai-embed', baseUrl },
  });
  const models = new ProviderModels(profile, providers, new ModelsDevCatalog());
  models.save({
    providerId: 'local-llm', capability: 'llm', modelId: 'route',
    contextWindow: 128_000, maxOutput: null, toolCall: null,
    reasoning: null, temperature: null, inputImage: null,
  });
  models.save({ providerId: 'local-embed', capability: 'embed', modelId: 'Pro/bge-m3', dim: 1024 });
  bindings = new ModelBindings(profile, models);
  bindings.set({ module: 'narrative-llm', providerId: 'local-llm', modelId: 'route' });
  bindings.set({ module: 'narrative-embed', providerId: 'local-embed', modelId: 'Pro/bge-m3' });
  settings = new SettingsStore(new SettingsRepo(profile.sqlite), { definitions: [narrativeQueryModeSetting] });
  host = openNarrative(narrative, providers, models, bindings, settings);
});

afterEach(async () => {
  narrative?.close();
  profile?.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
});

it('实际 Anthropic 路由/提词和 OpenAI Embed 能查 SQL, 只保存关键词缓存', async () => {
  const query = host.resolveSearch()!;
  const signal = new AbortController().signal;
  await query('剧情问题', 'hybrid', signal);
  expect(narrative.sqlite.prepare('SELECT * FROM keyword_cache').all()).toMatchObject([{
    high_level_keywords: '["事件"]', low_level_keywords: '["人物"]',
  }]);
  const llmCalls = () => requests.filter(request => request.url.endsWith('/messages'));
  expect(llmCalls()).toHaveLength(2);
  expect(llmCalls().every(request => request.body.max_tokens === 4096)).toBe(true);
  await query('剧情问题', 'hybrid', signal);
  expect(llmCalls()).toHaveLength(3);
  const result = await query('剧情问题', 'naive', signal);
  expect(result.get('1st_Loop')).toHaveProperty('text', expect.stringContaining('真实 SQLite 剧情正文'));
  expect(narrative.sqlite.prepare('SELECT COUNT(*) AS n FROM keyword_cache').get()).toEqual({ n: 1 });
});

it('算法设置和绑定按 Turn 冻结, 新 Turn 读取新值, 不读取角色名称', async () => {
  settings.set(narrativeQueryModeSetting, 'naive');
  const frozen = host.resolveSearch()!;
  settings.set(narrativeQueryModeSetting, 'global');
  bindings.delete('narrative-embed');
  expect(host.resolveSearch()).toBeUndefined();
  const result = await frozen('剧情问题', 'global', new AbortController().signal);
  expect(result.get('1st_Loop')).toHaveProperty('text', expect.stringContaining('真实 SQLite 剧情正文'));
  expect(requests.filter(request => request.url.endsWith('/messages'))).toHaveLength(1);
});

it('已取消的查询不发网络请求, 不写关键词缓存', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(host.resolveSearch()!('剧情问题', undefined, controller.signal)).rejects.toBeDefined();
  expect(requests).toHaveLength(0);
  expect(narrative.sqlite.prepare('SELECT COUNT(*) AS n FROM keyword_cache').get()).toEqual({ n: 0 });
});
