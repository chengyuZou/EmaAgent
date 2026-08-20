// 前端 Files 面板的本机文件浏览：列目录与有界文件预览（文本/图片/base64 分流）。
// 本机单人桌面应用，用户即机器所有者，任意路径读取是有意设计。
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import * as fsP from 'node:fs/promises';
import * as nodePath from 'node:path';

const pathQuery = z.object({
  path: z.string().min(1).max(2000),
});

/** 文件预览体积上限；超出只回尺寸让前端降级。 */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

const TEXT_EXTS = new Set([
  'md', 'mdx', 'txt', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp',
  'json', 'jsonl', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'css', 'scss', 'sass', 'less',
  'html', 'htm', 'xml', 'svg', 'sh', 'bash', 'zsh', 'fish', 'sql', 'graphql', 'gql', 'env', 'gitignore',
  'log', 'csv', 'tsv',
]);

const IMAGE_EXTS: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', ico: 'image/x-icon', bmp: 'image/bmp',
};

interface FileEntry {
  name: string;
  /** 正斜杠归一的绝对路径。 */
  path: string;
  type: 'file' | 'dir';
  /** 字节数；目录不带。 */
  size?: number;
}

export function filesRoute(): Hono {
  const app = new Hono();

  app.get('/files/ls', async context => {
    const parsed = pathQuery.safeParse(context.req.query());
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const dirPath = parsed.data.path;
    try {
      const stat = await fsP.stat(dirPath);
      if (!stat.isDirectory()) return context.json({ error: 'not_a_directory' }, 400);

      const raw = await fsP.readdir(dirPath, { withFileTypes: true });
      const entries = await Promise.all(
        raw.map(async (entry): Promise<FileEntry> => {
          let size: number | undefined;
          if (entry.isFile()) {
            try {
              size = (await fsP.stat(nodePath.join(dirPath, entry.name))).size;
            } catch {
              // 单文件 stat 失败只丢尺寸，不拖垮整列。
            }
          }
          return {
            name: entry.name,
            path: nodePath.join(dirPath, entry.name).replace(/\\/g, '/'),
            type: entry.isDirectory() ? 'dir' : 'file',
            size,
          };
        }),
      );
      // 目录在前，组内按名称（大小写不敏感）。
      entries.sort((left, right) => {
        if (left.type !== right.type) return left.type === 'dir' ? -1 : 1;
        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
      });
      return context.json({ entries });
    } catch (error) {
      return fsError(context, error);
    }
  });

  app.get('/files/file', async context => {
    const parsed = pathQuery.safeParse(context.req.query());
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const filePath = parsed.data.path;
    try {
      const stat = await fsP.stat(filePath);
      if (stat.isDirectory()) return context.json({ error: 'is_a_directory' }, 400);
      if (stat.size > MAX_PREVIEW_BYTES) {
        return context.json({ tooLarge: true, size: stat.size, limit: MAX_PREVIEW_BYTES });
      }

      const ext = (filePath.split(/[\\/]/).pop() ?? '').split('.').pop()?.toLowerCase() ?? '';
      const imageMime = IMAGE_EXTS[ext];
      if (imageMime) {
        const buffer = await fsP.readFile(filePath);
        return context.json({
          content: buffer.toString('base64'),
          encoding: 'base64' as const,
          mimeType: imageMime,
          size: stat.size,
        });
      }
      if (TEXT_EXTS.has(ext)) {
        const content = await fsP.readFile(filePath, 'utf8');
        return context.json({ content, encoding: 'text' as const, mimeType: 'text/plain', size: stat.size });
      }
      // 未知扩展名按 utf8 试读（大量配置/日志无扩展名）；替换字符占比高则判二进制。
      try {
        const content = await fsP.readFile(filePath, 'utf8');
        const sample = content.slice(0, 1000);
        const badRatio = (sample.match(/�/g)?.length ?? 0) / Math.max(sample.length, 1);
        if (badRatio > 0.1) throw new Error('likely binary');
        return context.json({ content, encoding: 'text' as const, mimeType: 'text/plain', size: stat.size });
      } catch {
        return context.json({ binary: true, mimeType: 'application/octet-stream', size: stat.size });
      }
    } catch (error) {
      return fsError(context, error);
    }
  });

  return app;
}

function fsError(context: Context, error: unknown): Response {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return context.json({ error: 'path_not_found' }, 404);
  if (code === 'EACCES') return context.json({ error: 'access_denied' }, 403);
  throw error;
}
