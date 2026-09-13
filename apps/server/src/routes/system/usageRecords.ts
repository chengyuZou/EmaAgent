// 用量明细查询(Token 明细页):sessionId/capability 可选过滤 + keyset 游标。
// repo 由 composition 全局装配(单库,不存在"按库选连接"的问题)。
import { Hono } from 'hono';
import { z } from 'zod';
import type { UsageRecordsRepo } from '@ema-agent/storage';
import { queryValidator } from '../validate.js';

const usageRecordsQuery = z.object({
  sessionId: z.string().min(1).optional(),
  capability: z.enum(['llm', 'vision', 'embed', 'rerank', 'stt', 'tts']).optional(),
  beforeCreatedAt: z.coerce.number().int().optional(),
  beforeId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
}).refine(
  input => (input.beforeCreatedAt === undefined) === (input.beforeId === undefined),
  { message: 'usage_record_cursor_incomplete' },
);

export const usageRecordsRoute = (deps: { usageRecords: UsageRecordsRepo }) =>
  new Hono()
    .get('/usage-records', queryValidator(usageRecordsQuery), context => {
      const { sessionId, capability, beforeCreatedAt, beforeId, limit } = context.req.valid('query');
      const page = deps.usageRecords.list({
        ...(sessionId ? { sessionId } : {}),
        ...(capability ? { capability } : {}),
        ...(beforeCreatedAt !== undefined && beforeId !== undefined
          ? { cursor: { createdAt: beforeCreatedAt, id: beforeId } }
          : {}),
        limit,
      });
      return context.json({
        items: page.items,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      });
    });
