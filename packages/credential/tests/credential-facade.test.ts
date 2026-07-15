import { describe, expect, it } from 'vitest';
import {
  CredentialFacade,
  CredentialIntegrityError,
  requireCredentialMasterKey,
} from '../src/index.js';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('CredentialFacade', () => {
  it('使用随机 nonce 加密并可按原 Provider 解密', () => {
    const facade = new CredentialFacade(KEY);
    const first = facade.protect('provider-1', 'sk-secret');
    const second = facade.protect('provider-1', 'sk-secret');

    expect(first).not.toBe(second);
    expect(first).not.toContain('sk-secret');
    expect(facade.reveal('provider-1', first)).toBe('sk-secret');
  });

  it('拒绝跨 Provider 搬运或篡改密文', () => {
    const facade = new CredentialFacade(KEY);
    const protectedValue = facade.protect('provider-1', 'sk-secret');

    expect(() => facade.reveal('provider-2', protectedValue)).toThrow(CredentialIntegrityError);
    expect(() => facade.reveal('provider-1', `${protectedValue}x`))
      .toThrow(CredentialIntegrityError);
  });

  it('主密钥缺失时 fail-closed', () => {
    expect(() => requireCredentialMasterKey({})).toThrow();
    expect(requireCredentialMasterKey({ EMA_CREDENTIAL_MASTER_KEY: KEY })).toBe(KEY);
  });
});
