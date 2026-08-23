// 记忆文件浏览：目录列表、内容读取与关键词搜索；可读范围白名单由 memory 包拥有。
import { Hono } from 'hono';
import { z } from 'zod';
import {
  listMemoryFiles,
  readMemoryFile,
  searchMemoryFiles,
} from '@ema-agent/memory';

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

export function memoryFilesRoute(deps: MemoryFilesRouteDeps): Hono {
  const app = new Hono();

  app.get('/files', async context => {
    const parsed = listQuery.safeParse(context.req.query());
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    return context.json(await listMemoryFiles(deps.memoryRoot, parsed.data));
  });

  app.get('/files/content', async context => {
    const parsed = readQuery.safeParse(context.req.query());
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const result = await readMemoryFile(deps.memoryRoot, parsed.data);
    if (!result) return context.json({ error: 'file_not_found' }, 404);
    return context.json(result);
  });

  app.post('/files/search', async context => {
    const parsed = searchBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    return context.json(await searchMemoryFiles(deps.memoryRoot, parsed.data));
  });

  return app;
}
