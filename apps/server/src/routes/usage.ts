import { Hono } from 'hono';
import { z } from 'zod';
import type { UsageRecorder } from '@ema-agent/usage';
import { queryValidator } from './validate.js';

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

export const usageRoute = (deps: { usageRecorder: UsageRecorder }) =>
  new Hono()
    .get('/records', queryValidator(usageRecordsQuery), context => {
      const { sessionId, capability, beforeCreatedAt, beforeId, limit } = context.req.valid('query');
      const page = deps.usageRecorder.list({
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
