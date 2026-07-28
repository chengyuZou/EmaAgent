// 处理 Session 偏好、独立 Fork、末轮重发、归档和永久删除动作。
import { Hono } from 'hono';
import { z } from 'zod';
import { asSessionId, asTurnId } from '@ema-agent/ids';
import type { SessionLifecycle, SessionStore } from '@ema-agent/session';

type SessionActionStore = Pick<
  SessionStore,
  | 'forkSession'
  | 'rewindLastTurn'
  | 'setViewedAt'
  | 'archiveSession'
  | 'unarchiveSession'
>;

const patchSessionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
  groupLabel: z.string().max(100).nullable().optional(),
  workspaceRoot: z.string().max(500).nullable().optional(),
  executionProfile: z.enum(['chat', 'work']).optional(),
  narrativePolicy: z.enum(['auto', 'always', 'off']).optional(),
  /** 用户希望该 Session 下一轮使用的模型；null 表示恢复系统默认选择。 */
  preferredModel: z.object({
    providerConfigId: z.string().min(1).max(200),
    modelId: z.string().min(1).max(500),
  }).strict().nullable().optional(),
});

const forkSchema = z.object({
  untilTurnId: z.string().optional(),
});

export function sessionActionsRoute(
  session: SessionActionStore,
  lifecycle: Pick<SessionLifecycle, 'updateSession' | 'deleteSession'>,
): Hono {
  const app = new Hono();

  app.put('/:id', async (c) => {
    const sessionId = asSessionId(c.req.param('id'));
    const body = patchSessionSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    }
    try {
      return c.json(lifecycle.updateSession(sessionId, {
        title: body.data.title,
        pinned: body.data.pinned,
        groupLabel: 'groupLabel' in body.data ? body.data.groupLabel ?? null : undefined,
        workspaceRoot: body.data.workspaceRoot,
        executionProfile: body.data.executionProfile,
        narrativePolicy: body.data.narrativePolicy,
        preferredModel: body.data.preferredModel,
      }));
    } catch (error) {
      if (errorStartsWith(error, 'session_not_found')) {
        return c.json({ error: 'session_not_found' }, 404);
      }
      throw error;
    }
  });

  app.post('/:id/fork', async (c) => {
    const body = forkSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    }
    try {
      return c.json(session.forkSession(
        asSessionId(c.req.param('id')),
        body.data.untilTurnId ? asTurnId(body.data.untilTurnId) : undefined,
      ), 201);
    } catch (error) {
      if (errorStartsWith(error, 'session_not_found')) {
        return c.json({ error: 'session_not_found' }, 404);
      }
      throw error;
    }
  });

  // 只服务“编辑最后一条用户消息”；不开放任意历史删除。
  app.post('/:id/turns/:turnId/rewind', (c) => {
    try {
      return c.json(session.rewindLastTurn(
        asSessionId(c.req.param('id')),
        asTurnId(c.req.param('turnId')),
      ));
    } catch (error) {
      if (errorStartsWith(error, 'turn_not_found')) {
        return c.json({ error: 'turn_not_found' }, 404);
      }
      if (errorStartsWith(error, 'turn_not_latest')) {
        return c.json({ error: 'turn_not_latest' }, 409);
      }
      if (errorStartsWith(error, 'turn_running')) {
        return c.json({ error: 'turn_running' }, 409);
      }
      if (error instanceof Error && error.message.includes('FOREIGN KEY constraint failed')) {
        return c.json({ error: 'turn_has_persistent_task' }, 409);
      }
      throw error;
    }
  });

  app.post('/:id/viewed', (c) => {
    try {
      session.setViewedAt(asSessionId(c.req.param('id')));
    } catch {
      // 已删除的 Session 不值得让前端“已读”请求失败。
    }
    return c.body(null, 204);
  });

  app.post('/:id/archive', (c) => {
    session.archiveSession(asSessionId(c.req.param('id')));
    return c.body(null, 204);
  });

  app.post('/:id/unarchive', (c) => {
    session.unarchiveSession(asSessionId(c.req.param('id')));
    return c.body(null, 204);
  });

  app.delete('/:id', (c) => {
    lifecycle.deleteSession(asSessionId(c.req.param('id')));
    return c.body(null, 204);
  });

  return app;
}

function errorStartsWith(error: unknown, prefix: string): boolean {
  return error instanceof Error && error.message.startsWith(prefix);
}
