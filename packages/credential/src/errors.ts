// 这里放 Credential 模块抛出的错误类型：主密钥配置错、密文完整性校验失败。

export class CredentialConfigurationError extends Error {
  override readonly name = 'CredentialConfigurationError';
}

export class CredentialIntegrityError extends Error {
  override readonly name = 'CredentialIntegrityError';
}
