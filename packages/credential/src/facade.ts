import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import {
  CredentialConfigurationError,
  CredentialIntegrityError,
} from './errors.js';

export interface CredentialEnvironment {
  EMA_CREDENTIAL_MASTER_KEY?: string;
}

const ENVELOPE_PREFIX = 'ema-credential:v1';
const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MASTER_KEY_BYTES = 32;

function decodeCanonicalBase64Url(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new CredentialIntegrityError('Provider 凭据密文包含非规范编码');
  }
  return decoded;
}

/** 从 Tauri 注入的环境变量读取由 OS keychain 保护的主密钥。 */
export function requireCredentialMasterKey(
  env: Readonly<CredentialEnvironment> = process.env,
): string {
  const key = env.EMA_CREDENTIAL_MASTER_KEY;
  if (!key || !/^[0-9a-f]{64}$/i.test(key)) {
    throw new CredentialConfigurationError(
      'EMA_CREDENTIAL_MASTER_KEY 缺失或格式错误，拒绝读取 Provider 凭据',
    );
  }
  return key;
}

/**
 * Provider 凭据加解密的唯一跨模块入口。
 *
 * 每条密文使用独立随机 nonce，并把 Provider ID 作为 AAD；即使数据库中的
 * 两行密文被交换，GCM 完整性校验也会拒绝解密。
 */
export class CredentialFacade {
  readonly #masterKey: Buffer;

  constructor(masterKeyHex: string) {
    if (!/^[0-9a-f]{64}$/i.test(masterKeyHex)) {
      throw new CredentialConfigurationError('Credential 主密钥必须是 32 字节十六进制');
    }
    this.#masterKey = Buffer.from(masterKeyHex, 'hex');
    if (this.#masterKey.length !== MASTER_KEY_BYTES) {
      throw new CredentialConfigurationError('Credential 主密钥长度错误');
    }
  }

  isProtected(value: string): boolean {
    return value.startsWith(`${ENVELOPE_PREFIX}:`);
  }

  protect(subjectId: string, plaintext: string): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#masterKey, nonce);
    cipher.setAAD(Buffer.from(subjectId, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return [
      ENVELOPE_PREFIX,
      nonce.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join(':');
  }

  reveal(subjectId: string, storedValue: string): string {
    // 兼容旧数据库；ProvidersRepo 会在启动时立即把这种值原地加密。
    if (!this.isProtected(storedValue)) return storedValue;

    const parts = storedValue.split(':');
    if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== ENVELOPE_PREFIX) {
      throw new CredentialIntegrityError('Provider 凭据密文格式损坏');
    }

    try {
      const nonce = decodeCanonicalBase64Url(parts[2]!);
      const tag = decodeCanonicalBase64Url(parts[3]!);
      const ciphertext = decodeCanonicalBase64Url(parts[4]!);
      if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
        throw new CredentialIntegrityError('Provider 凭据密文参数长度错误');
      }

      const decipher = createDecipheriv(ALGORITHM, this.#masterKey, nonce);
      decipher.setAAD(Buffer.from(subjectId, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (error: unknown) {
      if (error instanceof CredentialIntegrityError) throw error;
      throw new CredentialIntegrityError('Provider 凭据无法通过完整性校验');
    }
  }
}
