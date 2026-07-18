// 统一导出凭据加解密 Facade、环境接口和领域错误。
export { CredentialFacade, requireCredentialMasterKey } from './facade.js';
export type { CredentialEnvironment } from './facade.js';
export { CredentialConfigurationError, CredentialIntegrityError } from './errors.js';
