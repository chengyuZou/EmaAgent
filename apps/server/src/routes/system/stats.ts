// 存储统计：数据目录总量与单 Session 明细；只读投影，不承担写入。
import { Hono } from 'hono';
import { z } from 'zod';
import { queryValidator } from '../validate.js';
import {
  DataDirStatsRepo,
  MessagesRepo,
  SessionStatsRepo,
} from '@ema-agent/storage';

const rawMessagesQuery = z.object({
  beforeCreatedAt: z.coerce.number().int().optional(),
  beforeId: z.string().min(1).optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).refine(
  input => (input.beforeCreatedAt === undefined) === (input.beforeId === undefined),
  { message: 'raw_message_cursor_incomplete' },
);

export interface SystemStatsRouteDeps {
  readonly dataDirStats: Pick<DataDirStatsRepo, 'getStats'>;
  readonly sessionStats: Pick<SessionStatsRepo, 'getStats' | 'listSummaries'>;
  readonly messages: Pick<MessagesRepo, 'findById' | 'listHeadersPage'>;
}

export const systemStatsRoute = (deps: SystemStatsRouteDeps) =>
  new Hono()
    .get('/stats', context => context.json(deps.dataDirStats.getStats()))
    .get('/stats/sessions/:id', context => {
      return context.json(deps.sessionStats.getStats(context.req.param('id')));
    })
    // 存储页 Session 手风琴的行投影(身份+最后活跃+消息数+Token 合计)。
    .get('/stats/session-summaries', context => {
      return context.json({ sessions: deps.sessionStats.listSummaries() });
    })
    // 原始消息目录只下发行头；大块 blocks_json 必须等用户展开单条后再读。
    .get('/stats/sessions/:id/raw-messages', queryValidator(rawMessagesQuery), context => {
      const { beforeCreatedAt, beforeId, order, limit } = context.req.valid('query');
      const page = deps.messages.listHeadersPage(
        context.req.param('id'),
        beforeCreatedAt === undefined || beforeId === undefined
          ? undefined
          : { createdAt: beforeCreatedAt, id: beforeId },
        limit,
        order,
      );
      return context.json({
        messages: page.rows.map(message => ({
          id: message.id,
          role: message.role,
          createdAt: message.created_at,
        })),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      });
    })
    .get('/stats/sessions/:id/raw-messages/:messageId', context => {
      const message = deps.messages.findById(context.req.param('messageId'));
      if (!message || message.session_id !== context.req.param('id')) {
        return context.json({ error: 'message_not_found' }, 404);
      }
      return context.json({ blocksJson: message.blocks_json });
    });
