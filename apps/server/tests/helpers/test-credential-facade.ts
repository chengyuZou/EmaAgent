import { CredentialFacade } from '@ema-agent/credential';

const TEST_MASTER_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

export function createTestCredentialFacade(): CredentialFacade {
  return new CredentialFacade(TEST_MASTER_KEY);
}
