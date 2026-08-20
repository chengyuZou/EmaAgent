// Permission 与 AskUser 的用户回答通道：统一 toolCallId 锚，Session FIFO 由交互队列保证。
import { Hono } from 'hono';
import { z } from 'zod';
import type { SessionInteractionQueue } from '@ema-agent/turn';

const permissionRespondBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('allow') }),
  z.object({ action: z.literal('allowSession') }),
  z.object({ action: z.literal('deny'), reason: z.string().optional() }),
]);

const askUserRespondBody = z.object({
  answers: z.record(z.string(), z.string()),
});

export interface TurnInteractionsRouteDeps {
  readonly queue: SessionInteractionQueue;
}

/**
 * 回答/取消按 toolCallId 定位，expectedTurnId 防止陈旧卡片误答另一个 Turn。
 * pending 供窗口重开/SSE 重连后恢复在飞卡片。
 */
export function turnInteractionsRoute(deps: TurnInteractionsRouteDeps): Hono {
  const app = new Hono();
  const queue = deps.queue;

  app.get('/interactions/pending', context => {
    const pending = queue.listPending();
    return context.json({ count: pending.length, pending });
  });

  app.post('/:turnId/permissions/:toolCallId/respond', async context => {
    const parsed = permissionRespondBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const ok = queue.respondPermission(
      context.req.param('toolCallId'),
      parsed.data,
      context.req.param('turnId'),
    );
    if (!ok) return context.json({ error: 'not_found_or_expired' }, 404);
    return context.json({ ok: true });
  });

  app.post('/:turnId/permissions/:toolCallId/cancel', context => {
    const ok = queue.cancelPermission(
      context.req.param('toolCallId'),
      'cancelled by user',
      context.req.param('turnId'),
    );
    if (!ok) return context.json({ error: 'not_found_or_expired' }, 404);
    return context.json({ ok: true });
  });

  app.post('/:turnId/ask-user/:toolCallId/respond', async context => {
    const parsed = askUserRespondBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const ok = queue.respondAskUser(
      context.req.param('toolCallId'),
      parsed.data.answers,
      context.req.param('turnId'),
    );
    if (!ok) return context.json({ error: 'not_found_or_expired' }, 404);
    return context.json({ ok: true });
  });

  // 取消不能伪装成提交空答案，否则 Agent 无法区分两种用户意图。
  app.post('/:turnId/ask-user/:toolCallId/cancel', context => {
    const ok = queue.cancelAskUser(
      context.req.param('toolCallId'),
      'cancelled by user',
      context.req.param('turnId'),
    );
    if (!ok) return context.json({ error: 'not_found_or_expired' }, 404);
    return context.json({ ok: true });
  });

  return app;
}
