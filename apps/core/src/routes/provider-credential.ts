import type { Hono } from 'hono';
import { z } from 'zod';
import {
  PROVIDER_CONFIG_LIMITS,
  type ProviderCredentialOperation,
} from '@ema-agent/contracts';
import type { AppBindings } from '../wiring/index.js';

export const providerCredentialOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('keep') }).strict(),
  z.object({
    type: z.literal('replace'),
    value: z.string().min(1).max(PROVIDER_CONFIG_LIMITS.apiKeyChars),
  }).strict(),
  z.object({ type: z.literal('clear') }).strict(),
]);

/** 将显式凭据操作解析为数据库下一状态。 */
export function resolveProviderCredential(
  current: string | null,
  operation: ProviderCredentialOperation | undefined,
): string | null {
  if (operation === undefined || operation.type === 'keep') return current;
  if (operation.type === 'clear') return null;
  return operation.value;
}

/**
 * 注册需要返回明文凭据的敏感路由。
 * V1 允许本地用户主动查看自己的密钥，但禁止编辑页自动拉取和 HTTP 缓存。
 */
export function registerProviderCredentialRoutes(app: Hono, bindings: AppBindings): void {
  app.post('/:id/credential/reveal', (c) => {
    const row = bindings.providers.get(c.req.param('id'));
    if (!row) return c.json({ error: 'not_found' }, 404);

    c.header('Cache-Control', 'no-store, private');
    c.header('Pragma', 'no-cache');
    return c.json({ credential: row.credential ?? '' });
  });
}
