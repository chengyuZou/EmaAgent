// 数据目录注册表：多 DataDir 的注册/移除/切换/迁移；切换活动项后当前进程仍连着旧库，必须重启生效。
import fs from 'node:fs';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Database } from '@ema-agent/storage';
import {
  addDir,
  loadRegistry,
  removeDir,
  setActive,
} from '../../platform/dataDirRegistry.js';

const addBody = z.object({
  name: z.string().min(1).max(100),
  path: z.string().min(1),
});

const migrateBody = z.object({
  name: z.string().min(1).max(100),
  targetPath: z.string().min(1),
});

export interface DataDirsRouteDeps {
  readonly activeDataDir: string;
  readonly dataDb: Database;
}

export function dataDirsRoute(deps: DataDirsRouteDeps): Hono {
  const app = new Hono();

  app.get('/data-dirs', context => {
    return context.json(loadRegistry());
  });

  app.post('/data-dirs', async context => {
    const parsed = addBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    try {
      return context.json(addDir(loadRegistry(), parsed.data), 201);
    } catch (error) {
      return registryError(context, error);
    }
  });

  app.delete('/data-dirs/:name', context => {
    try {
      return context.json(removeDir(loadRegistry(), context.req.param('name')));
    } catch (error) {
      return registryError(context, error);
    }
  });

  // 写入新活动项即完成；当前进程的数据源仍是旧目录，由宿主/前端决定重启流程。
  app.post('/data-dirs/:name/activate', context => {
    try {
      const registry = setActive(loadRegistry(), context.req.param('name'));
      return context.json({ ...registry, restartRequired: true });
    } catch (error) {
      return registryError(context, error);
    }
  });

  // 迁移：SQLite 在线 backup 热拷贝 data.db + 文件目录复制，注册并切换后要求重启。
  app.post('/data-dirs/migrate', async context => {
    const parsed = migrateBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const { name, targetPath } = parsed.data;
    if (path.resolve(targetPath) === path.resolve(deps.activeDataDir)) {
      return context.json({ error: 'same_path', message: '目标路径与当前路径相同' }, 400);
    }
    try {
      fs.mkdirSync(targetPath, { recursive: true });
      await deps.dataDb.sqlite.backup(path.join(targetPath, 'data.db'));
      for (const subdir of ['sessions', 'audio']) {
        const source = path.join(deps.activeDataDir, subdir);
        if (fs.existsSync(source)) {
          fs.cpSync(source, path.join(targetPath, subdir), { recursive: true });
        }
      }
      setActive(addDir(loadRegistry(), { name, path: targetPath }), name);
      return context.json({ ok: true, restartRequired: true, targetPath });
    } catch (error) {
      return context.json({
        error: 'migrate_failed',
        message: error instanceof Error ? error.message : String(error),
      }, 500);
    }
  });

  return app;
}

function registryError(context: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('not found')) {
    return context.json({ error: 'data_dir_not_found', message }, 404);
  }
  if (message.includes('cannot remove')) {
    return context.json({ error: 'data_dir_conflict', message }, 409);
  }
  return context.json({ error: 'invalid_request', message }, 400);
}
