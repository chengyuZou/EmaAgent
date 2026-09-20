// Session 动作：偏好修改、fork、末轮回退、已读、归档与永久删除。
import { Hono } from 'hono';
import { z } from 'zod';
import type { SessionStore } from '@ema-agent/session';
import type { TurnStore } from '@ema-agent/turn';
import { jsonBody } from '../validate.js';

const patchSessionBody = z.object({
  title: z.string().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
  cwd: z.string().min(1).max(500).optional(),
  executionProfile: z.enum(['chat', 'work']).optional(),
  narrativePolicy: z.enum(['auto', 'always', 'off']).optional(),
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions']).optional(),
  providerId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  reasoningEffort: z.enum(['off', 'low', 'medium', 'high', 'max']).optional(),
}).refine(body => (body.providerId === undefined) === (body.modelId === undefined), {
  message: 'providerId 与 modelId 必须同时提供',
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
  /** 回退会删除父 Turn 行, 必须先停仍在写 transcript 的派生 AgentRun. */
  readonly abortAgentRunsForTurn: (turnId: string) => Promise<void>;
  /** 跨域删除用例（application/deleteSession）由装配层绑定 composition 后传入。 */
  readonly deleteSession: (sessionId: string) => Promise<void>;
}

export const sessionActionsRoute = (deps: SessionActionsRouteDeps) =>
  new Hono()
    .put('/:sessionId', jsonBody(patchSessionBody), async context => {
      const sessionId = context.req.param('sessionId');
      const patch = context.req.valid('json');
      try {
        deps.session.patchSession(sessionId, patch);
        return context.json(deps.session.getSession(sessionId));
      } catch (error) {
        if (errorMessageStartsWith(error, 'session_not_found')) {
          return context.json({ error: 'session_not_found' }, 404);
        }
        if (errorMessageStartsWith(error, 'session_cwd_invalid')) {
          return context.json({ error: 'session_cwd_invalid' }, 400);
        }
        throw error;
      }
    })
    // fork 到最新也要显式发 {}：契约一律声明，不吞真空 body。
    .post('/:sessionId/fork', jsonBody(forkBody), async context => {
      try {
        return context.json(
          deps.session.forkSession(
            context.req.param('sessionId'),
            context.req.valid('json').untilTurnId,
          ),
          201,
        );
      } catch (error) {
        if (errorMessageStartsWith(error, 'session_not_found')) {
          return context.json({ error: 'session_not_found' }, 404);
        }
        throw error;
      }
    })
    // TODO: 当前 Desktop 禁止消息回退。此接口删除整 Turn，未来不能直接复用为单条 Message 编辑。
    .post('/:sessionId/turns/:turnId/rewind', async context => {
      try {
        await deps.abortAgentRunsForTurn(context.req.param('turnId'));
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
    })
    .post('/:sessionId/viewed', context => {
      try {
        deps.session.setViewedAt(context.req.param('sessionId'));
      } catch {
        // 已删除的 Session 不值得让前端"已读"请求失败。
      }
      return context.body(null, 204);
    })
    .post('/:sessionId/archive', context => {
      deps.session.archiveSession(context.req.param('sessionId'));
      return context.body(null, 204);
    })
    .post('/:sessionId/unarchive', context => {
      deps.session.unarchiveSession(context.req.param('sessionId'));
      return context.body(null, 204);
    })
    .delete('/:sessionId', async context => {
      await deps.deleteSession(context.req.param('sessionId'));
      return context.body(null, 204);
    });

function errorMessageStartsWith(error: unknown, prefix: string): boolean {
  return error instanceof Error && error.message.startsWith(prefix);
}
