// 这是 Credential 包的统一出口，外部代码从这里使用凭据加解密功能。

export { CredentialFacade, requireCredentialMasterKey } from './facade.js';
export type { CredentialEnvironment } from './facade.js';
export { CredentialConfigurationError, CredentialIntegrityError } from './errors.js';
