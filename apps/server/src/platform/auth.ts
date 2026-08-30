// 管理 Desktop WebView 访问本机 Server 的跨域与共享密钥边界。
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';
import { cors } from 'hono/cors';

const EMA_SECRET_HEADER = 'x-ema-secret';
const MIN_SECRET_LENGTH = 32;

/**
 * 放行开发页面与 Tauri WebView 对本机 Server 的跨域请求。
 * 必须挂在 emaAuth 之前，否则携带 X-Ema-Secret 的请求会在 OPTIONS 预检阶段被误判为未授权。
 */
export function localWebviewCors() {
  return cors({
    origin: (origin) => {
      if (!origin) return origin;
      try {
        const { hostname } = new URL(origin);
        if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === 'tauri.localhost') {
          return origin;
        }
      } catch {
        return null;
      }
      return null;
    },
    allowHeaders: ['Content-Type', 'X-Ema-Secret'],
  });
}

export class MissingSharedSecretError extends Error {
  constructor(message = 'EMA_SHARED_SECRET 未配置或长度不足，server 拒绝以无认证模式启动') {
    super(message);
    this.name = 'MissingSharedSecretError';
  }
}

/** 在打开数据库和监听端口前读取共享密钥；任何环境都不允许静默退化为无认证服务。 */
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

/** 校验 X-Ema-Secret 的 Hono 中间件；运行时禁止 fail-open。 */
export function emaAuth(secret: string) {
  if (secret.length < MIN_SECRET_LENGTH) throw new MissingSharedSecretError();
  const expectedDigest = digestSecret(secret);

  return async (c: Context, next: Next) => {
    // 健康检查不包含用户数据，保留给 Tauri 启动探测使用。
    if (c.req.path === '/health') return next();

    const provided = c.req.header(EMA_SECRET_HEADER);
    if (!timingSafeEqual(digestSecret(provided), expectedDigest)) {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  };
}
