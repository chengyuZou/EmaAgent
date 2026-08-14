// 测试 Provider 密钥只能显式查看，并严格区分保留、替换和清空操作。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, ModelBindingsRepo, ProvidersRepo } from '@ema-agent/storage';
import {
  ProviderConfiguration,
  PROVIDER_CONFIG_LIMITS,
  providerCatalog,
} from '@ema-agent/provider';
import { providerConfigurationRoute } from '../src/routes/providers/providerConfiguration.js';
import { StorageProviderConfigurationStore } from '../src/wiring/providers/providerConfigurationStore.js';
import { createTestCredentialFacade } from './helpers/test-credential-facade.js';

describe('Provider 凭据契约', () => {
  let profileDb: Database;
  let providers: ProvidersRepo;
  let app: ReturnType<typeof providerConfigurationRoute>;

  beforeEach(() => {
    profileDb = new Database({ memory: true, kind: 'profile' });
    profileDb.migrate();
    providers = new ProvidersRepo(profileDb.sqlite, createTestCredentialFacade());
    providers.upsert({
      id: 'provider-1',
      definitionId: 'siliconflow',
      displayName: 'SiliconFlow',
      apiKey: 'secret-v1',
      capabilities: [{ capability: 'llm' }],
    });
    app = providerConfigurationRoute(new ProviderConfiguration(
      providerCatalog,
      new StorageProviderConfigurationStore(providers),
      new ModelBindingsRepo(profileDb.sqlite),
      { refresh() {} },
      () => 'new-provider',
    ));
  });

  afterEach(() => profileDb.close());

  it('只有显式 POST reveal 才返回明文，并禁止缓存', async () => {
    const response = await app.request('/provider-1/credential/reveal', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    await expect(response.json()).resolves.toEqual({ credential: 'secret-v1' });
    expect((await app.request('/provider-1/key')).status).toBe(404);
  });

  it('keep、replace、clear 三种操作不会互相混淆', async () => {
    const patch = (credential: unknown) => app.request('/provider-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential }),
    });

    expect((await patch({ type: 'keep' })).status).toBe(200);
    expect(providers.get('provider-1')?.credential).toBe('secret-v1');

    expect((await patch({ type: 'replace', value: 'secret-v2' })).status).toBe(200);
    expect(providers.get('provider-1')?.credential).toBe('secret-v2');

    expect((await patch({ type: 'clear' })).status).toBe(200);
    expect(providers.get('provider-1')?.credential).toBeNull();
  });

  it('旧 apiKey 隐式写法和空 replace 都被拒绝', async () => {
    const request = (body: unknown) => app.request('/provider-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect((await request({ apiKey: 'ambiguous' })).status).toBe(400);
    expect((await request({ credential: { type: 'replace', value: '' } })).status).toBe(400);
    expect(providers.get('provider-1')?.credential).toBe('secret-v1');
  });

  it('拒绝超过统一长度上限的密钥和 Base URL', async () => {
    const request = (body: unknown) => app.request('/provider-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect((await request({
      credential: { type: 'replace', value: 'k'.repeat(PROVIDER_CONFIG_LIMITS.apiKeyChars + 1) },
    })).status).toBe(400);
    expect((await request({
      capability: {
        capability: 'llm',
        baseUrl: 'h'.repeat(PROVIDER_CONFIG_LIMITS.baseUrlChars + 1),
      },
    })).status).toBe(400);
    expect(providers.get('provider-1')?.credential).toBe('secret-v1');
  });
});
