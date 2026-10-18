import { Hono } from 'hono';
import { z } from 'zod';
import { SessionPlanGoalConflictError, SessionWorkBlockedError, type SessionStore } from '@ema-agent/session';
import type { TurnStore } from '@ema-agent/turn';
import { jsonBody } from '../validate.js';
import type { ArchivedSessionsDeletionResult } from '../../application/sessionActions.js';

const patchSessionBody = z.object({
  title: z.string().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
  cwd: z.string().min(1).max(500).optional(),
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan']).optional(),
  ttsEnabled: z.boolean().optional(),
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
    | 'unarchiveSession'
  >;
  readonly turns: Pick<TurnStore, 'rewindLastTurn'>;
  /** 回退前先停该 Turn 发起的运行中子代理, 再删除 Turn. */
  readonly abortSubagentsForTurn: (turnId: string) => Promise<void>;
  readonly assertSessionWorkAllowed: (sessionId: string) => void;
  readonly archiveSession: (sessionId: string) => Promise<void>;
  readonly deleteSession: (sessionId: string) => Promise<void>;
  readonly deleteArchivedSessions: () => Promise<ArchivedSessionsDeletionResult>;
}

export const sessionActionsRoute = (deps: SessionActionsRouteDeps) =>
  new Hono()
    // 静态路径必须在 /:sessionId 的 DELETE 前注册, archived 不是会话 ID.
    .delete('/archived', async context => {
      try {
        return context.json(await deps.deleteArchivedSessions());
      } catch (error) {
        if (error instanceof SessionWorkBlockedError) {
          return context.json({
            error: error.code,
            message: '有归档会话仍在停止工作, 请等待归档完成后再删除.',
          }, 409);
        }
        throw error;
      }
    })
    .put('/:sessionId', jsonBody(patchSessionBody), async context => {
      const sessionId = context.req.param('sessionId');
      const patch = context.req.valid('json');
      try {
        deps.session.patchSession(sessionId, patch);
        return context.json(deps.session.getSession(sessionId));
      } catch (error) {
        if (error instanceof SessionPlanGoalConflictError) {
          return context.json({ error: error.code, goalId: error.goalId }, 409);
        }
        if (errorMessageStartsWith(error, 'session_not_found')) {
          return context.json({ error: 'session_not_found' }, 404);
        }
        if (errorMessageStartsWith(error, 'session_cwd_invalid')) {
          return context.json({ error: 'session_cwd_invalid' }, 400);
        }
        throw error;
      }
    })
    // 不指定回退位置时也要发送 {}, 空请求体不符合 JSON 契约.
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
    // 回退删除整个 Turn, 不是编辑单条 Message. Desktop 当前不提供回退操作.
    .post('/:sessionId/turns/:turnId/rewind', async context => {
      try {
        await deps.abortSubagentsForTurn(context.req.param('turnId'));
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
          // 含 Task 的 Turn 受删除保护(RESTRICT),回退必须整体回滚.
          return context.json({ error: 'turn_has_persistent_task' }, 409);
        }
        throw error;
      }
    })
    .post('/:sessionId/viewed', context => {
      try {
        deps.session.setViewedAt(context.req.param('sessionId'));
      } catch {
        // 已删除的 Session 不值得让前端"已读"请求失败.
      }
      return context.body(null, 204);
    })
    .post('/:sessionId/archive', async context => {
      try {
        await deps.archiveSession(context.req.param('sessionId'));
        return context.body(null, 204);
      } catch (error) {
        if (errorMessageStartsWith(error, 'session_not_found')) {
          return context.json({ error: 'session_not_found' }, 404);
        }
        throw error;
      }
    })
    .post('/:sessionId/unarchive', context => {
      try {
        const sessionId = context.req.param('sessionId');
        deps.assertSessionWorkAllowed(sessionId);
        deps.session.unarchiveSession(sessionId);
        return context.body(null, 204);
      } catch (error) {
        if (error instanceof SessionWorkBlockedError) {
          return context.json({ error: error.code, message: '会话正在停止工作, 请等待操作完成后再取消归档.' }, 409);
        }
        if (errorMessageStartsWith(error, 'session_not_found')) {
          return context.json({ error: 'session_not_found' }, 404);
        }
        throw error;
      }
    })
    .delete('/:sessionId', async context => {
      try {
        await deps.deleteSession(context.req.param('sessionId'));
        return context.body(null, 204);
      } catch (error) {
        if (errorMessageStartsWith(error, 'session_not_found')) {
          return context.json({ error: 'session_not_found' }, 404);
        }
        throw error;
      }
    });

function errorMessageStartsWith(error: unknown, prefix: string): boolean {
  return error instanceof Error && error.message.startsWith(prefix);
}
