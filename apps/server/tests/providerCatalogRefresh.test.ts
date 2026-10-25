import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '@ema-agent/storage';
import { Hono } from 'hono';
import { openProviders, type ProvidersComposition } from '../src/composition/providers.js';
import { providerModelsRoute } from '../src/routes/providers/models.js';
import { providerConfigsRoute } from '../src/routes/providers/configs.js';

function payload(contextWindow: number, extraModel = 'new-model'): string {
  return JSON.stringify({ acme: { models: {
    'existing-model': {
      name: 'Existing', modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: contextWindow, output: 1000 },
    },
    'manual-model': {
      modalities: { input: ['text'], output: ['text'] }, limit: { context: 90000 },
    },
    [extraModel]: {
      modalities: { input: ['text', 'image'], output: ['text'] }, limit: { context: 16000 },
    },
  } } });
}

describe('完整模型目录刷新', () => {
  let directory: string;
  let filePath: string;
  let db: Database;
  let composition: ProvidersComposition;
  let notify: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-catalog-'));
    vi.stubEnv('EMA_PROFILE_DIR', directory);
    filePath = path.join(directory, 'profile', 'models-dev.json');
    fs.mkdirSync(path.dirname(filePath));
    fs.writeFileSync(filePath, payload(8000, 'retained-model'));
    db = new Database({ memory: true, kind: 'profile' });
    await db.migrate();
    notify = vi.fn();
    composition = openProviders(db, notify);
    composition.providers.create({
      id: 'test', name: 'Test', authType: 'none',
      capability: { capability: 'llm', protocol: 'openai-llm', baseUrl: 'http://localhost/v1', modelsDevId: 'acme' },
    });
    composition.providers.update('test', {
      capability: { capability: 'llm', modelsDevId: 'acme' },
    });
    composition.providers.update('test', {
      capability: { capability: 'vision', protocol: 'openai-llm', baseUrl: 'http://localhost/v1', modelsDevId: 'acme' },
    });
    composition.providerModels.save({
      providerId: 'test', capability: 'llm', modelId: 'manual-model', contextWindow: 4000,
      maxOutput: null, reasoning: null, toolCall: null, inputImage: null, temperature: null,
    });
    composition.providerModels.syncDevModels('test', 'llm');
    composition.providerModels.syncDevModels('test', 'vision');
    composition.providerModels.setEnabled('test', 'llm', 'existing-model', true);
    composition.modelBindings.set({ module: 'memory-llm', providerId: 'test', modelId: 'existing-model' });
  });

  afterEach(() => {
    db.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function app() {
    return providerModelsRoute({
      ...composition,
      notifyProviderModelsChanged: notify,
      notifyModelBindingsChanged: () => undefined,
    });
  }

  it('刷新指定供应商的 LLM 时, 其他供应商和该供应商的 Vision 记录完全不变', async () => {
    composition.providers.create({
      id: 'other', name: 'Other', authType: 'none',
      capability: { capability: 'llm', protocol: 'openai-llm', baseUrl: 'http://localhost/v1' },
    });
    composition.providers.update('other', {
      capability: { capability: 'llm', modelsDevId: 'acme' },
    });
    composition.providerModels.syncDevModels('other', 'llm');
    const untouched = () => db.sqlite.prepare(
      "SELECT * FROM provider_models WHERE provider_id != 'test' OR capability != 'llm' ORDER BY provider_id, capability, model_id",
    ).all();
    const before = untouched();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(payload(32000))));
    await composition.refreshModels('test', 'llm');
    expect(composition.providerModels.get('test', 'llm', 'existing-model').contextWindow).toBe(32000);
    expect(untouched()).toEqual(before);
    expect(notify.mock.calls).toEqual([['test']]);
  });

  it('打开列表和供应商, 保存配置均不下载目录, 手动刷新才发出请求', async () => {
    const fetchCatalog = vi.fn(async () => new Response(payload(32000)));
    vi.stubGlobal('fetch', fetchCatalog);
    const route = new Hono().route('/', app()).route('/', providerConfigsRoute({
      providers: composition.providers,
      notifyProviderConfigChanged: () => undefined,
    }));
    expect((await route.request('/')).status).toBe(200);
    expect((await route.request('/test')).status).toBe(200);
    expect((await route.request('/test/models')).status).toBe(200);
    expect((await route.request('/test', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Renamed' }),
    })).status).toBe(200);
    expect(fetchCatalog).not.toHaveBeenCalled();
    expect((await route.request('/test/models/refresh?capability=llm', { method: 'POST' })).status).toBe(200);
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
  });

  it('并发的 LLM/Vision 请求只下载一次, 各自同步指定能力并保留参数和绑定', async () => {
    const text = payload(32000);
    const fetchCatalog = vi.fn(async () => new Response(text));
    vi.stubGlobal('fetch', fetchCatalog);
    const held = composition.modelCatalog;
    const route = app();
    const responses = await Promise.all([
      route.request('/test/models/refresh?capability=llm', { method: 'POST' }),
      route.request('/test/models/refresh?capability=vision', { method: 'POST' }),
    ]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const [llmResult, visionResult] = await Promise.all(responses.map(response => response.json()));
    expect(llmResult.models.every((model: { capability: string }) => model.capability === 'llm')).toBe(true);
    expect(visionResult.models.every((model: { capability: string }) => model.capability === 'vision')).toBe(true);
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
    expect(held).toBe(composition.modelCatalog);
    expect(held.get('acme', 'existing-model')?.contextWindow).toBe(32000);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(text);
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['models-dev.json']);
    const rows = db.sqlite.prepare('SELECT * FROM provider_models WHERE provider_id = ?').all('test');
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: 'llm', model_id: 'existing-model', context_window: 32000, enabled: 1 }),
      expect.objectContaining({ capability: 'vision', model_id: 'new-model', input_image: 1, enabled: 0 }),
      expect.objectContaining({ capability: 'llm', model_id: 'new-model', enabled: 0 }),
      expect.objectContaining({ capability: 'llm', model_id: 'manual-model', context_window: 4000, source: 'user' }),
      expect.objectContaining({ model_id: 'retained-model' }),
    ]));
    expect(composition.modelBindings.get('memory-llm')?.modelId).toBe('existing-model');
    expect(notify.mock.calls).toEqual([['test'], ['test']]);

    composition.providers.create({
      id: 'added-after', name: 'Later', authType: 'none',
      capability: { capability: 'llm', protocol: 'openai-llm', baseUrl: 'http://localhost/v1', modelsDevId: 'acme' },
    });
    composition.providers.update('added-after', {
      capability: { capability: 'llm', modelsDevId: 'acme' },
    });
    expect((await route.request('/added-after/models/refresh?capability=llm', { method: 'POST' })).status).toBe(200);
    expect(composition.providerModels.get('added-after', 'llm', 'new-model').enabled).toBe(false);
  });

  it.each(['network', 'json', 'empty'])('%s 失败返回明确错误, 保留原文件和 SQL', async failure => {
    const beforeFile = fs.readFileSync(filePath, 'utf8');
    const beforeRows = db.sqlite.prepare('SELECT * FROM provider_models').all();
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (failure === 'network') throw new Error('offline');
      return new Response(failure === 'json' ? '{invalid' : '{}');
    }));
    const response = await app().request('/test/models/refresh?capability=llm', { method: 'POST' });
    expect(response.status).toBe(503);
    expect(await response.json()).toHaveProperty('error', 'model_catalog_refresh_failed');
    expect(fs.readFileSync(filePath, 'utf8')).toBe(beforeFile);
    expect(db.sqlite.prepare('SELECT * FROM provider_models').all()).toEqual(beforeRows);
    expect(composition.modelCatalog.get('acme', 'existing-model')?.contextWindow).toBe(8000);
    expect(notify).not.toHaveBeenCalled();
  });

  it('SQL 中途失败撤回整批修改, 文件未变化的下一次刷新仍可补齐 SQL', async () => {
    const text = payload(64000, 'reject-model');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(text)));
    db.sqlite.exec(`CREATE TRIGGER reject_catalog BEFORE INSERT ON provider_models
      WHEN NEW.model_id = 'reject-model' BEGIN SELECT RAISE(ABORT, 'write rejected'); END`);
    expect((await app().request('/test/models/refresh?capability=llm', { method: 'POST' })).status).toBe(503);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(text);
    expect(composition.providerModels.get('test', 'llm', 'existing-model').contextWindow).toBe(8000);
    expect(notify).not.toHaveBeenCalled();
    db.sqlite.exec('DROP TRIGGER reject_catalog');
    expect((await app().request('/test/models/refresh?capability=llm', { method: 'POST' })).status).toBe(200);
    expect(composition.providerModels.get('test', 'llm', 'existing-model').contextWindow).toBe(64000);
    expect(composition.providerModels.get('test', 'llm', 'reject-model')).toMatchObject({ inputImage: true });
    expect(composition.providerModels.get('test', 'vision', 'existing-model').contextWindow).toBe(8000);
  });
});
