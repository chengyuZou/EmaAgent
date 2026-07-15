import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';

const EMA_SECRET_HEADER = 'x-ema-secret';
const MIN_SECRET_LENGTH = 32;

export class MissingSharedSecretError extends Error {
  constructor(message = 'EMA_SHARED_SECRET 未配置或长度不足，Core 拒绝以无认证模式启动') {
    super(message);
    this.name = 'MissingSharedSecretError';
  }
}

/**
 * 在打开数据库和监听端口前读取 Sidecar 密钥，缺失时直接终止启动。
 * 开发环境也必须显式提供密钥，禁止静默退化为无认证服务。
 */
export function requireSharedSecret(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const secret = env['EMA_SHARED_SECRET'];
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new MissingSharedSecretError();
  }
  return secret;
}

function digestSecret(value: string | undefined): Buffer {
  return createHash('sha256').update(value ?? '', 'utf8').digest();
}

function secretsEqual(provided: string | undefined, expectedDigest: Buffer): boolean {
  return timingSafeEqual(digestSecret(provided), expectedDigest);
}

/**
 * 校验 X-Ema-Secret 的 Hono 中间件。
 * 密钥由 Tauri 注入并在启动期校验，运行时禁止 fail-open。
 */
export function emaAuth(secret: string) {
  if (secret.length < MIN_SECRET_LENGTH) throw new MissingSharedSecretError();
  const expectedDigest = digestSecret(secret);

  return async (c: Context, next: Next) => {
    // 健康检查不包含用户数据，保留给 Tauri 启动探测使用。
    if (c.req.path === '/health') return next();

    const provided = c.req.header(EMA_SECRET_HEADER);
    if (!secretsEqual(provided, expectedDigest)) {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'unauthorized' }, 401);
    }

    return next();
  };
}
