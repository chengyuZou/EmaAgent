/**
 * GET /api/workspace/ls?path=<absolute path>
 *
 * Lists directory contents for the Files panel. Since this is a local
 * single-user desktop app the user runs on their own machine, arbitrary
 * path reads are intentional — the user IS the owner.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import * as fsP from 'node:fs/promises';
import * as nodePath from 'node:path';

const lsSchema = z.object({
  path: z.string().min(1).max(2000),
});

interface FileEntry {
  name:  string;
  /** Forward-slash normalised absolute path. */
  path:  string;
  type:  'file' | 'dir';
  /** File size in bytes — omitted for directories. */
  size?: number;
}

const app = new Hono();

app.get('/ls', async (c) => {
  const parsed = lsSchema.safeParse({ path: c.req.query('path') });
  if (!parsed.success) return c.json({ error: 'path required' }, 400);

  const dirPath = parsed.data.path;

  try {
    const stat = await fsP.stat(dirPath);
    if (!stat.isDirectory()) return c.json({ error: 'not_a_directory' }, 400);

    const raw = await fsP.readdir(dirPath, { withFileTypes: true });

    const entries = await Promise.all(
      raw.map(async (e): Promise<FileEntry> => {
        let size: number | undefined;
        if (e.isFile()) {
          try {
            size = (await fsP.stat(nodePath.join(dirPath, e.name))).size;
          } catch { /* ignore stat failure on individual files */ }
        }
        return {
          name: e.name,
          path: nodePath.join(dirPath, e.name).replace(/\\/g, '/'),
          type: e.isDirectory() ? 'dir' : 'file',
          size,
        };
      }),
    );

    // Directories first, then files; alphabetical within each group.
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    return c.json({ entries });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT')  return c.json({ error: 'path_not_found' }, 404);
    if (code === 'EACCES')  return c.json({ error: 'access_denied' },  403);
    throw err;
  }
});

const fileSchema = z.object({
  path: z.string().min(1).max(2000),
});

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024; // 2MB 预览上限

const TEXT_EXTS = new Set([
  'md','mdx','txt','ts','tsx','js','jsx','mjs','cjs','py','rs','go','java','c','cpp','h','hpp',
  'json','jsonl','jsonc','yaml','yml','toml','ini','cfg','conf','css','scss','sass','less',
  'html','htm','xml','svg','sh','bash','zsh','fish','sql','graphql','gql','env','gitignore',
  'log','csv','tsv',
]);
const IMAGE_EXTS: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', ico: 'image/x-icon', bmp: 'image/bmp',
};

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

app.get('/file', async (c) => {
  const parsed = fileSchema.safeParse({ path: c.req.query('path') });
  if (!parsed.success) return c.json({ error: 'path required' }, 400);
  const filePath = parsed.data.path;

  try {
    const stat = await fsP.stat(filePath);
    if (stat.isDirectory()) return c.json({ error: 'is_a_directory' }, 400);
    if (stat.size > MAX_PREVIEW_BYTES) {
      return c.json({ tooLarge: true, size: stat.size, limit: MAX_PREVIEW_BYTES });
    }

    const ext = extOf(filePath.split(/[\\/]/).pop() ?? '');
    const isText = TEXT_EXTS.has(ext);
    const imageMime = IMAGE_EXTS[ext];

    if (imageMime) {
      const buf = await fsP.readFile(filePath);
      return c.json({
        content: buf.toString('base64'),
        encoding: 'base64' as const,
        mimeType: imageMime,
        size: stat.size,
      });
    }
    if (isText) {
      const content = await fsP.readFile(filePath, 'utf8');
      return c.json({
        content,
        encoding: 'text' as const,
        mimeType: 'text/plain',
        size: stat.size,
      });
    }
    // 未知扩展名:尝试按 utf8 读(很多配置/日志无扩展名但可读)。失败回 binary。
    try {
      const content = await fsP.readFile(filePath, 'utf8');
      // 含大量替换字符说明不是合法 utf8 -> 当 binary
      const sample = content.slice(0, 1000);
      const badRatio = (sample.match(/�/g)?.length ?? 0) / Math.max(sample.length, 1);
      if (badRatio > 0.1) throw new Error('likely binary');
      return c.json({ content, encoding: 'text' as const, mimeType: 'text/plain', size: stat.size });
    } catch {
      return c.json({ binary: true, mimeType: 'application/octet-stream', size: stat.size });
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT')  return c.json({ error: 'path_not_found' }, 404);
    if (code === 'EACCES')  return c.json({ error: 'access_denied' },  403);
    throw err;
  }
});

export function workspaceRoute(): Hono { return app; }
