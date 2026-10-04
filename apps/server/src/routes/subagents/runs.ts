// 身份下的执行记录查询, 统计与结果只属于选中的 Run.
import { Hono } from 'hono';
import { z } from 'zod';
import type { SubagentStore } from '@ema-agent/agent';
import { queryValidator } from '../validate.js';

const runsQuery = z.object({
  beforeCreatedAt: z.coerce.number().int().optional(),
  beforeId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).refine(
  value => (value.beforeCreatedAt === undefined) === (value.beforeId === undefined),
  { message: 'beforeCreatedAt and beforeId must be provided together' }
);

export const subagentRunsRoute = (deps: { readonly subagents: SubagentStore }) => new Hono()
  .get('/:subagentId/runs', queryValidator(runsQuery), context => {
    const subagentId = context.req.param('subagentId');
    if (!deps.subagents.get(subagentId)) {
      return context.json({ error: 'subagent_not_found' }, 404);
    }
    const { beforeCreatedAt, beforeId, limit } = context.req.valid('query');
    const cursor = beforeCreatedAt !== undefined && beforeId !== undefined
      ? { createdAt: beforeCreatedAt, id: beforeId }
      : undefined;

    return context.json(deps.subagents.listRuns(subagentId, cursor, limit));
  })
  .get('/:subagentId/runs/:runId', context => {
    const run = deps.subagents.getRun(context.req.param('runId'));
    if (!run || run.subagentId !== context.req.param('subagentId')) {
      return context.json({ error: 'subagent_run_not_found' }, 404);
    }

    return context.json(run);
  });
