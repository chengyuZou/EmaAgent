// 提供 AskUser 等待快照、回答和显式取消的 Turn 级 HTTP 接口。

import type { Hono } from 'hono';
import { z } from 'zod';
import { asTurnId } from '@ema-agent/ids';
import {
  filterAskUserPending,
  type PendingInteraction,
} from '@ema-agent/turn';
import type { AskUserRequiredEvent } from '@ema-agent/tools';

const askUserAnswerSchema = z.object({
  answers: z.record(z.string()),
});

export interface AskUserInteractionQueue {
  listPending(): PendingInteraction<unknown, AskUserRequiredEvent>[];
  respondAskUser(
    promptId: string,
    answers: Record<string, string>,
    expectedTurnId?: string,
  ): boolean;
  cancelAskUser(
    promptId: string,
    reason?: string,
    expectedTurnId?: string,
  ): boolean;
}

export function registerAskUserRoutes(
  app: Hono,
  interactionQueue: AskUserInteractionQueue,
): void {
  app.get('/pending/ask-user', (context) => {
    const prompts = filterAskUserPending(
      interactionQueue.listPending(),
    );
    return context.json({ count: prompts.length, prompts });
  });

  // promptId 定位交互，turnId 防止陈旧卡片误答另一个 Turn。
  app.post('/:turnId/ask-user/:promptId/respond', async (context) => {
    const turnId = asTurnId(context.req.param('turnId'));
    const promptId = context.req.param('promptId');
    const parsed = askUserAnswerSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json({
        error: 'invalid_request',
        details: parsed.error.flatten(),
      }, 400);
    }

    const ok = interactionQueue.respondAskUser(
      promptId,
      parsed.data.answers,
      turnId,
    );
    if (!ok) {
      return context.json({
        error: 'not_found_or_expired',
        promptId,
      }, 404);
    }
    return context.json({ ok: true });
  });

  // 取消不能伪装成提交空答案，否则 Agent 无法区分两种用户意图。
  app.post('/:turnId/ask-user/:promptId/cancel', (context) => {
    const turnId = asTurnId(context.req.param('turnId'));
    const promptId = context.req.param('promptId');
    const ok = interactionQueue.cancelAskUser(
      promptId,
      'cancelled by user',
      turnId,
    );
    if (!ok) {
      return context.json({
        error: 'not_found_or_expired',
        promptId,
      }, 404);
    }
    return context.json({ ok: true });
  });
}
