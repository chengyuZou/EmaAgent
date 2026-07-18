export class CredentialConfigurationError extends Error {
  override readonly name = 'CredentialConfigurationError';
}

export class CredentialIntegrityError extends Error {
  override readonly name = 'CredentialIntegrityError';
}
