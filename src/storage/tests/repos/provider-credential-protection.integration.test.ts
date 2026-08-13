// 测试普通 Provider 查询不泄露凭据，显式读取时可从加密信封恢复。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, ProvidersRepo } from '../../index.js';
import { createTestCredentialFacade } from '../helpers/test-credential-facade.js';

describe('Provider 凭据保护', () => {
  let database: Database;
  let providers: ProvidersRepo;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    providers = new ProvidersRepo(database.sqlite, createTestCredentialFacade());
  });

  afterEach(() => database.close());

  it('SQLite 只保存加密信封，普通查询只暴露 hasCredential', () => {
    providers.save({
      id: 'provider-1',
      providerId: 'openai',
      displayName: 'OpenAI',
      credential: 'sk-sensitive',
      enabled: true,
      capabilities: [
        { capability: 'llm', activeProtocol: 'openai-llm', protocols: [{ protocol: 'openai-llm', baseUrl: 'https://api.openai.com/v1' }] },
      ],
    });

    const raw = database.sqlite.prepare(
      'SELECT credential_envelope FROM provider_configs WHERE id = ?',
    ).get('provider-1') as { credential_envelope: string };
    expect(raw.credential_envelope).toMatch(/^ema-credential:v1:/);
    expect(raw.credential_envelope).not.toContain('sk-sensitive');
    expect(providers.get('provider-1')).toMatchObject({ hasCredential: true });
    expect(providers.revealCredential('provider-1')).toBe('sk-sensitive');
  });

  it('undefined 保留凭据，null 明确清空凭据', () => {
    const base = {
      id: 'provider-1', providerId: 'openai', displayName: 'OpenAI', enabled: true,
      capabilities: [
        { capability: 'llm' as const, activeProtocol: 'openai-llm' as const, protocols: [{ protocol: 'openai-llm' as const, baseUrl: 'https://api.openai.com/v1' }] },
      ],
    };
    providers.save({ ...base, credential: 'secret' });
    providers.save(base);
    expect(providers.revealCredential('provider-1')).toBe('secret');
    providers.save({ ...base, credential: null });
    expect(providers.revealCredential('provider-1')).toBeNull();
  });
});
