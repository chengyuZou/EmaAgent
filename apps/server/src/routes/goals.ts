// 用户管理入口只调用 GoalStore, 续接由提交后的事件唤醒现有消息队列.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { GoalError, type GoalStore } from '@ema-agent/goal';
import { jsonBody, paramValidator, queryValidator } from './validate.js';

type GoalRouteStore = Pick<GoalStore,
  'listSummaries' | 'getCurrent' | 'get' | 'create' | 'edit' | 'pause' | 'activate' | 'cancel' | 'delete'
>;

const sessionQuery = z.object({ sessionId: z.string().min(1) });
const goalParam = z.object({ goalId: z.string().min(1) });
const objective = z.string().refine(text => text.trim().length > 0, '目标正文不能为空');
const createBody = z.object({ sessionId: z.string().min(1), objective }).strict();
const identityBody = z.object({
  sessionId: z.string().min(1),
  expectedVersion: z.number().int().positive(),
}).strict();
const editBody = identityBody.extend({ objective });

export const goalsRoute = (goals: GoalRouteStore) =>
  new Hono()
    .get('/', queryValidator(sessionQuery), context => {
      const { sessionId } = context.req.valid('query');
      return context.json({ items: goals.listSummaries(sessionId) });
    })
    .get('/current', queryValidator(sessionQuery), context => {
      const { sessionId } = context.req.valid('query');
      return context.json({ goal: goals.getCurrent(sessionId) });
    })
    .get('/:goalId', paramValidator(goalParam), queryValidator(sessionQuery), context => {
      const { sessionId } = context.req.valid('query');
      const { goalId } = context.req.valid('param');
      const goal = goals.get(sessionId, goalId);
      if (!goal) return goalError(context, new GoalError('goal_not_found'));
      return context.json({ goal });
    })
    .post('/', jsonBody(createBody), context => {
      const { sessionId, objective } = context.req.valid('json');
      try {
        return context.json({ goal: goals.create(sessionId, objective) }, 201);
      } catch (error) {
        return goalError(context, error);
      }
    })
    .put('/:goalId', paramValidator(goalParam), jsonBody(editBody), context => {
      const { goalId } = context.req.valid('param');
      const { sessionId, expectedVersion, objective } = context.req.valid('json');
      try {
        return context.json({ goal: goals.edit({ sessionId, goalId, expectedVersion }, objective) });
      } catch (error) {
        return goalError(context, error);
      }
    })
    .post('/:goalId/pause', paramValidator(goalParam), jsonBody(identityBody), context => {
      const { goalId } = context.req.valid('param');
      const { sessionId, expectedVersion } = context.req.valid('json');
      try {
        return context.json({ goal: goals.pause({ sessionId, goalId, expectedVersion }) });
      } catch (error) {
        return goalError(context, error);
      }
    })
    .post('/:goalId/activate', paramValidator(goalParam), jsonBody(identityBody), context => {
      const { goalId } = context.req.valid('param');
      const { sessionId, expectedVersion } = context.req.valid('json');
      try {
        return context.json({ goal: goals.activate({ sessionId, goalId, expectedVersion }) });
      } catch (error) {
        return goalError(context, error);
      }
    })
    .post('/:goalId/cancel', paramValidator(goalParam), jsonBody(identityBody), context => {
      const { goalId } = context.req.valid('param');
      const { sessionId, expectedVersion } = context.req.valid('json');
      try {
        return context.json({ goal: goals.cancel({ sessionId, goalId, expectedVersion }) });
      } catch (error) {
        return goalError(context, error);
      }
    })
    .delete('/:goalId', paramValidator(goalParam), jsonBody(identityBody), context => {
      const { goalId } = context.req.valid('param');
      const { sessionId, expectedVersion } = context.req.valid('json');
      try {
        goals.delete({ sessionId, goalId, expectedVersion });
        return context.body(null, 204);
      } catch (error) {
        return goalError(context, error);
      }
    });

function goalError(context: Context, error: unknown) {
  if (!(error instanceof GoalError)) throw error;
  switch (error.code) {
    case 'session_not_found':
      return context.json({ error: error.code, message: '会话不存在.' }, 404);
    case 'goal_not_found':
      return context.json({ error: error.code, message: '目标不存在或已删除, 请刷新目标信息.' }, 404);
    case 'goal_version_conflict':
      return context.json({ error: error.code, message: '目标已更新, 请刷新后再决定操作.' }, 409);
    case 'goal_status_conflict':
      return context.json({ error: error.code, message: '当前目标状态不允许此操作, 请刷新目标信息.' }, 409);
    case 'goal_already_exists':
      return context.json({ error: error.code, message: '已有进行中或暂停的目标, 请先关闭它.' }, 409);
    case 'goal_plan_conflict':
      return context.json({ error: error.code, message: 'Plan 与 Goal 互斥, 请先关闭 Plan.' }, 409);
    case 'goal_objective_empty':
    case 'goal_feedback_empty':
    case 'goal_error_empty':
      return context.json({ error: error.code, message: '目标正文, 进度或失败说明不能为空.' }, 400);
  }
}
