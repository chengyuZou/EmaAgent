// 签发并验证跨重启可用的本地文件能力句柄，阻止前端伪造任意绝对路径。
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import type { AttachmentInput } from './types.js';

const HANDLE_PREFIX = 'ema-file:v1';
const HANDLE_DOMAIN = Buffer.from('ema-file-capability:v1', 'utf8');
const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface AuthorizedAttachmentInput {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  mtime: number;
  fileHandle: string;
}

function decodeCanonicalBase64Url(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new Error('文件能力句柄包含非规范编码');
  }
  return decoded;
}

export class FileAccessFacade {
  readonly #key: Buffer;

  constructor(masterKeyHex: string) {
    if (!/^[0-9a-f]{64}$/i.test(masterKeyHex)) {
      throw new Error('文件能力主密钥必须是 32 字节十六进制');
    }
    const masterKey = Buffer.from(masterKeyHex, 'hex');
    this.#key = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), HANDLE_DOMAIN, KEY_BYTES));
  }

  issue(localPath: string): string {
    const normalizedPath = normalizeAbsolutePath(localPath);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#key, nonce);
    cipher.setAAD(HANDLE_DOMAIN);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify({ path: normalizedPath }), 'utf8'),
      cipher.final(),
    ]);
    const sealed = Buffer.concat([ciphertext, cipher.getAuthTag()]);
    return `${HANDLE_PREFIX}:${nonce.toString('base64url')}:${sealed.toString('base64url')}`;
  }

  resolve(fileHandle: string): string {
    const parts = fileHandle.split(':');
    if (parts.length !== 4 || `${parts[0]}:${parts[1]}` !== HANDLE_PREFIX) {
      throw new Error('文件能力句柄格式错误');
    }

    try {
      const nonce = decodeCanonicalBase64Url(parts[2]!);
      const sealed = decodeCanonicalBase64Url(parts[3]!);
      if (nonce.length !== NONCE_BYTES || sealed.length <= TAG_BYTES) {
        throw new Error('文件能力句柄参数长度错误');
      }
      const ciphertext = sealed.subarray(0, sealed.length - TAG_BYTES);
      const tag = sealed.subarray(sealed.length - TAG_BYTES);
      const decipher = createDecipheriv(ALGORITHM, this.#key, nonce);
      decipher.setAAD(HANDLE_DOMAIN);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');
      const payload: unknown = JSON.parse(plaintext);
      if (!isFilePayload(payload)) throw new Error('文件能力负载格式错误');
      return normalizeAbsolutePath(payload.path);
    } catch {
      throw new Error('文件能力句柄无法通过完整性校验');
    }
  }

  prepareAttachment(input: AuthorizedAttachmentInput): AttachmentInput {
    const localPath = this.resolve(input.fileHandle);
    const metadata = statSync(localPath);
    if (!metadata.isFile()) throw new Error('附件能力指向的不是普通文件');
    const actualName = path.basename(localPath);
    return {
      id: input.id,
      name: actualName,
      mimeType: input.mimeType,
      size: metadata.size,
      mtime: Math.trunc(metadata.mtimeMs),
      localPath,
    };
  }
}

function normalizeAbsolutePath(value: string): string {
  if (value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error('文件能力只接受绝对路径');
  }
  return path.normalize(value);
}

function isFilePayload(value: unknown): value is { path: string } {
  return typeof value === 'object'
    && value !== null
    && Object.keys(value).length === 1
    && typeof (value as { path?: unknown }).path === 'string';
}
