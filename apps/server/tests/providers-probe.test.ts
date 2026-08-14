// 测试 Provider 探测在执行 Adapter 前正确返回不存在与能力未启用错误。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, ProvidersRepo } from '@ema-agent/storage';
import { ProviderProbe } from '@ema-agent/provider';
import { providerProbesRoute } from '../src/routes/providers/providerProbes.js';
import { StorageProviderConfigurationStore } from '../src/wiring/providers/providerConfigurationStore.js';
import { createTestCredentialFacade } from './helpers/test-credential-facade.js';

describe('B-061 probe 路由错误响应不被 204 覆盖', () => {
  let profileDb: Database;
  let providers: ProvidersRepo;

  beforeEach(() => {
    profileDb = new Database({ memory: true, kind: 'profile' });
    profileDb.migrate();
    providers = new ProvidersRepo(profileDb.sqlite, createTestCredentialFacade());
    providers.upsert({
      id: 'provider-1',
      definitionId: 'siliconflow',
      displayName: 'SiliconFlow',
      apiKey: 'secret',
      capabilities: [{ capability: 'llm' }],
    });
  });

  afterEach(() => profileDb.close());

  it('provider 不存在时返回 404 而非 204 空', async () => {
    const app = createProbeRoute(providers);
    const res = await app.request('/missing-id/probe/llm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: 'not_found' });
  });

  it('provider 不支持该 capability 时返回 422 而非 204 空', async () => {
    const app = createProbeRoute(providers);
    const res = await app.request('/provider-1/probe/embed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      error: 'capability_not_supported',
      capability: 'embed',
    });
  });
});

function createProbeRoute(providers: ProvidersRepo) {
  const store = new StorageProviderConfigurationStore(providers);
  return providerProbesRoute(new ProviderProbe(
    store,
    {
      firstEnabled: () => undefined,
      firstCatalog: () => undefined,
    },
    {
      probe: () => {
        throw new Error('前置校验失败时不应执行 Adapter');
      },
    },
    {
      record: () => {
        throw new Error('前置校验失败时不应写入健康状态');
      },
    },
  ));
}
