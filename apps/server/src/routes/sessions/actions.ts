// Session 动作：偏好修改、fork、末轮回退、已读、归档与永久删除。
import { Hono } from 'hono';
import { z } from 'zod';
import type { SessionStore } from '@ema-agent/session';
import type { TurnStore } from '@ema-agent/turn';

const patchSessionBody = z.object({
  title: z.string().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
  /** null 表示移出工作区；undefined 表示保持不变。 */
  workspaceRoot: z.string().min(1).max(500).nullable().optional(),
  executionProfile: z.enum(['chat', 'work']).optional(),
  narrativePolicy: z.enum(['auto', 'always', 'off']).optional(),
  /** 该 Session 后续 Turn 的模型偏好；null 恢复默认解析。 */
  model: z.object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
  }).nullable().optional(),
});

const forkBody = z.object({
  untilTurnId: z.string().min(1).optional(),
});

export interface SessionActionsRouteDeps {
  readonly session: Pick<
    SessionStore,
    | 'patchSession'
    | 'getSession'
    | 'forkSession'
    | 'setViewedAt'
    | 'archiveSession'
    | 'unarchiveSession'
  >;
  readonly turns: Pick<TurnStore, 'rewindLastTurn'>;
  /** 工作区变更必须淘汰绑定旧工作区的命令运行器。 */
  readonly invalidateSessionRunner: (sessionId: string) => void;
  /** 跨域删除用例（application/deleteSession）由装配层绑定 composition 后传入。 */
  readonly deleteSession: (sessionId: string) => Promise<void>;
}

export function sessionActionsRoute(deps: SessionActionsRouteDeps): Hono {
  const app = new Hono();

  app.put('/:sessionId', async context => {
    const sessionId = context.req.param('sessionId');
    const parsed = patchSessionBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    try {
      deps.session.patchSession(sessionId, parsed.data);
      if (parsed.data.workspaceRoot !== undefined) {
        deps.invalidateSessionRunner(sessionId);
      }
      return context.json(deps.session.getSession(sessionId));
    } catch (error) {
      if (errorMessageStartsWith(error, 'session_not_found')) {
        return context.json({ error: 'session_not_found' }, 404);
      }
      if (errorMessageStartsWith(error, 'session_workspace_locked_by_project')) {
        return context.json({ error: 'session_workspace_locked_by_project' }, 409);
      }
      throw error;
    }
  });

  app.post('/:sessionId/fork', async context => {
    const parsed = forkBody.safeParse(await context.req.json().catch(() => ({})));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    try {
      return context.json(
        deps.session.forkSession(context.req.param('sessionId'), parsed.data.untilTurnId),
        201,
      );
    } catch (error) {
      if (errorMessageStartsWith(error, 'session_not_found')) {
        return context.json({ error: 'session_not_found' }, 404);
      }
      throw error;
    }
  });

  // 只服务"编辑最后一条用户消息"；不开放任意历史删除。
  app.post('/:sessionId/turns/:turnId/rewind', context => {
    try {
      return context.json(deps.turns.rewindLastTurn(
        context.req.param('sessionId'),
        context.req.param('turnId'),
      ));
    } catch (error) {
      if (errorMessageStartsWith(error, 'turn_not_found')) {
        return context.json({ error: 'turn_not_found' }, 404);
      }
      if (
        errorMessageStartsWith(error, 'turn_not_latest')
        || errorMessageStartsWith(error, 'turn_running')
      ) {
        return context.json({ error: 'turn_not_rewindable' }, 409);
      }
      if (error instanceof Error && error.message.includes('FOREIGN KEY constraint failed')) {
        // 含 Task 的 Turn 受删除保护（RESTRICT），回退必须整体回滚。
        return context.json({ error: 'turn_has_persistent_task' }, 409);
      }
      throw error;
    }
  });

  app.post('/:sessionId/viewed', context => {
    try {
      deps.session.setViewedAt(context.req.param('sessionId'));
    } catch {
      // 已删除的 Session 不值得让前端"已读"请求失败。
    }
    return context.body(null, 204);
  });

  app.post('/:sessionId/archive', context => {
    deps.session.archiveSession(context.req.param('sessionId'));
    return context.body(null, 204);
  });

  app.post('/:sessionId/unarchive', context => {
    deps.session.unarchiveSession(context.req.param('sessionId'));
    return context.body(null, 204);
  });

  app.delete('/:sessionId', async context => {
    await deps.deleteSession(context.req.param('sessionId'));
    return context.body(null, 204);
  });

  return app;
}

function errorMessageStartsWith(error: unknown, prefix: string): boolean {
  return error instanceof Error && error.message.startsWith(prefix);
}
