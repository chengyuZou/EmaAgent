import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, ProvidersRepo } from '../../index.js';
import { createTestCredentialFacade } from '../helpers/test-credential-facade.js';

describe('Provider 凭据落盘保护', () => {
  let database: Database;
  let providers: ProvidersRepo;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    providers = new ProvidersRepo(database.sqlite, createTestCredentialFacade());
  });

  afterEach(() => database.close());

  it('Repo 对业务返回明文，但 SQLite 中只保存认证加密信封', () => {
    providers.upsert({
      id: 'provider-1',
      definitionId: 'openai',
      displayName: 'OpenAI',
      apiKey: 'sk-sensitive',
      capabilities: [{ capability: 'llm' }],
    });

    const raw = database.sqlite
      .prepare('SELECT credential_envelope FROM provider_configs WHERE id = ?')
      .get('provider-1') as { credential_envelope: string };
    expect(raw.credential_envelope).toMatch(/^ema-credential:v1:/);
    expect(raw.credential_envelope).not.toContain('sk-sensitive');
    expect(providers.get('provider-1')?.credential).toBe('sk-sensitive');
  });

  it('旧库明文在单事务中原地升级，业务读取保持兼容', () => {
    const now = Date.now();
    database.sqlite.prepare(
      `INSERT INTO provider_configs
         (id, definition_id, display_name, credential_envelope, enabled,
          config_json, capabilities_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, '{}', '["llm"]', ?, ?)`,
    ).run('legacy-provider', 'openai', 'Legacy', 'legacy-secret', now, now);

    expect(providers.protectLegacyCredentials()).toBe(1);
    const raw = database.sqlite
      .prepare('SELECT credential_envelope FROM provider_configs WHERE id = ?')
      .get('legacy-provider') as { credential_envelope: string };
    expect(raw.credential_envelope).toMatch(/^ema-credential:v1:/);
    expect(providers.get('legacy-provider')?.credential).toBe('legacy-secret');
  });
});
