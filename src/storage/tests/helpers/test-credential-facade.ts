import { CredentialFacade } from '@ema-agent/credential';

const TEST_MASTER_KEY =
  'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

export function createTestCredentialFacade(): CredentialFacade {
  return new CredentialFacade(TEST_MASTER_KEY);
}
