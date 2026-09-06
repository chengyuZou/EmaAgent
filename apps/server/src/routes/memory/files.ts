import path from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  listMemoryFiles,
  readMemoryFile,
  searchMemoryFiles,
} from '@ema-agent/memory';
import { jsonBody, queryValidator } from '../validate.js';

export interface MemoryFilesRouteDeps {
  readonly memoryRoot: string;
}

const listQuery = z.object({
  path: z.string().max(512).optional(),
  cursor: z.string().max(64).optional(),
  maxResults: z.coerce.number().int().min(1).max(2_000).optional(),
});

const readQuery = z.object({
  path: z.string().min(1).max(512),
  lineOffset: z.coerce.number().int().min(1).optional(),
  maxLines: z.coerce.number().int().min(1).max(10_000).optional(),
});

const searchBody = z.object({
  queries: z.array(z.string().min(1).max(200)).min(1).max(8),
  matchMode: z.enum(['any', 'all_on_same_line', 'all_within_lines']).optional(),
  path: z.string().max(512).optional(),
  cursor: z.string().max(64).optional(),
  contextLines: z.number().int().min(0).max(20).optional(),
  caseSensitive: z.boolean().optional(),
  normalized: z.boolean().optional(),
  maxResults: z.number().int().min(1).max(200).optional(),
});

export const memoryFilesRoute = (deps: MemoryFilesRouteDeps) =>
  new Hono()
    .get('/files', queryValidator(listQuery), async context =>
      context.json(await listMemoryFiles(deps.memoryRoot, context.req.valid('query'))))
    .get('/files/content', queryValidator(readQuery), async context => {
      const result = await readMemoryFile(deps.memoryRoot, context.req.valid('query'));
      return result
        ? context.json({
            ...result,
            absolutePath: path.join(deps.memoryRoot, result.path),
          })
        : context.json({ error: 'file_not_found' }, 404);
    })
    .post('/files/search', jsonBody(searchBody), async context =>
      context.json(await searchMemoryFiles(deps.memoryRoot, context.req.valid('json'))));
