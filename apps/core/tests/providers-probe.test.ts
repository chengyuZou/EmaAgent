import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, ProvidersRepo } from '@ema-agent/storage';
import type { AppBindings } from '../src/wiring/index.js';
import { providersRoute } from '../src/routes/providers.js';
import { createTestCredentialFacade } from './helpers/test-credential-facade.js';

// B-061：probe 路由的前置校验（not_found / capability_not_supported）必须把
// 构造好的 404/422 响应真正返回给调用方，而不是被 204 空响应覆盖。
// not_found / cap_not_supported 都在调 adapter 之前返回，所以无需 mock 任何 adapter。
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
      capabilities: ['llm'],
    });
  });

  afterEach(() => profileDb.close());

  it('provider 不存在时返回 404 而非 204 空', async () => {
    const app = providersRoute({ providers } as unknown as AppBindings);
    const res = await app.request('/missing-id/probe/llm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: 'not_found' });
  });

  it('provider 不支持该 capability 时返回 422 而非 204 空', async () => {
    const app = providersRoute({ providers } as unknown as AppBindings);
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
