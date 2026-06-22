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

export function workspaceRoute(): Hono { return app; }
