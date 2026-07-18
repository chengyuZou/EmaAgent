// 定义主密钥配置错误与凭据密文完整性错误。
export class CredentialConfigurationError extends Error {
  override readonly name = 'CredentialConfigurationError';
}

export class CredentialIntegrityError extends Error {
  override readonly name = 'CredentialIntegrityError';
}
