// 数据目录注册表：多 DataDir 的注册/删除/切换/迁移,以及任意已注册库的只读浏览。
// 删除分两档:只摘注册(磁盘不动)与全部删除(白名单磁盘清除);
// 活动库删除前必须安静(无活动执行)并先关闭数据库连接,返回 restartRequired。
// 只读浏览:活动库走活连接,非活动库按路径懒缓存只读连接(WAL 下能读外部写入)。
import fs from 'node:fs';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  DataDirStatsRepo,
  Database,
  MessagesRepo,
  SessionsRepo,
} from '@ema-agent/storage';
import type { ActiveSessionRegistry } from '@ema-agent/session';
import {
  addDir,
  loadRegistry,
  removeDir,
  setActive,
  wipeDataDirContents,
} from '../../platform/dataDirRegistry.js';
import { dataDbPathFor } from '../../platform/paths.js';
import { jsonBody, queryValidator } from '../validate.js';

const addBody = z.object({
  name: z.string().min(1).max(100),
  path: z.string().min(1),
});

const migrateBody = z.object({
  name: z.string().min(1).max(100),
  targetPath: z.string().min(1),
});

const rawMessagesQuery = z.object({
  before: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const wipeQuery = z.object({
  wipe: z.enum(['1']).optional(),
});

export interface DataDirsRouteDeps {
  readonly activeDataDir: string;
  readonly dataDb: Database;
  readonly activeSessions: ActiveSessionRegistry;
  /** 活动库删除前调用:关闭两个活动数据库连接(调用方随后提示重启)。 */
  readonly closeDatabases: () => void;
  /** 非活动库只读连接的缓存容器;生产缺省进程级,测试可注入以便关闭。 */
  readonly readonlyDbs?: Map<string, Database>;
}

export const dataDirsRoute = (deps: DataDirsRouteDeps) => {
  /** 非活动库的只读连接懒缓存,按目录路径键控(WAL 下能读外部写入)。 */
  const readonlyDbs = deps.readonlyDbs ?? new Map<string, Database>();

  function dbForDir(dirPath: string, isActive: boolean): Database {
    if (isActive) return deps.dataDb;
    let db = readonlyDbs.get(dirPath);
    if (!db) {
      db = new Database({ path: dataDbPathFor(dirPath), kind: 'data', readonly: true });
      readonlyDbs.set(dirPath, db);
    }
    return db;
  }

  function dirEntry(name: string) {
    const registry = loadRegistry();
    const entry = registry.dirs.find(d => d.name === name);
    return { registry, entry, isActive: registry.active === name };
  }

  return new Hono()
    .get('/data-dirs', context => {
      return context.json(loadRegistry());
    })
    .post('/data-dirs', jsonBody(addBody), async context => {
      try {
        return context.json(addDir(loadRegistry(), context.req.valid('json')), 201);
      } catch (error) {
        return registryError(context, error);
      }
    })
    .delete('/data-dirs/:name', queryValidator(wipeQuery), context => {
      const name = context.req.param('name');
      const wipe = context.req.valid('query').wipe === '1';
      const { registry, entry, isActive } = dirEntry(name);
      if (!entry) return context.json({ error: 'dir_not_found' }, 404);
      if (registry.dirs.length <= 1) {
        return context.json({ error: 'cannot_remove_last' }, 409);
      }
      if (isActive) {
        // 活动库有动静一律不删:这个业务不负责替用户收拾正在跑的东西。
        if (deps.activeSessions.activeSessionCount() > 0) {
          return context.json({ error: 'dir_busy' }, 409);
        }
        // 安静后先断库连接(Windows 文件锁下不先关删不动),调用方提示重启。
        deps.closeDatabases();
      }
      const wipeResult = wipe ? wipeDataDirContents(entry.path) : undefined;
      try {
        const next = removeDir(loadRegistry(), name);
        return context.json({
          ...next,
          restartRequired: isActive,
          wipe: wipeResult ?? null,
        });
      } catch (error) {
        return registryError(context, error);
      }
    })
    // 写入新活动项即完成；当前进程的数据源仍是旧目录，由宿主/前端决定重启流程。
    .post('/data-dirs/:name/activate', context => {
      try {
        const registry = setActive(loadRegistry(), context.req.param('name'));
        return context.json({ ...registry, restartRequired: true });
      } catch (error) {
        return registryError(context, error);
      }
    })
    // 迁移：SQLite 在线 backup 热拷贝 data.db + 文件目录复制，注册并切换后要求重启。
    .post('/data-dirs/migrate', jsonBody(migrateBody), async context => {
      const { name, targetPath } = context.req.valid('json');
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
    })
    // ── 只读浏览(L1 卡统计 / L2 session 列表 / L3 raw 消息) ─────────────────
    .get('/data-dirs/:name/stats', context => {
      const { entry, isActive } = dirEntry(context.req.param('name'));
      if (!entry) return context.json({ error: 'dir_not_found' }, 404);
      const stats = new DataDirStatsRepo(dbForDir(entry.path, isActive).sqlite).getStats();
      return context.json(stats);
    })
    .get('/data-dirs/:name/sessions', context => {
      const { entry, isActive } = dirEntry(context.req.param('name'));
      if (!entry) return context.json({ error: 'dir_not_found' }, 404);
      const sessions = new SessionsRepo(dbForDir(entry.path, isActive).sqlite).listEnrichedAll();
      return context.json({ sessions });
    })
    .get('/data-dirs/:name/sessions/:sessionId/messages',
      queryValidator(rawMessagesQuery), context => {
      const { entry, isActive } = dirEntry(context.req.param('name'));
      if (!entry) return context.json({ error: 'dir_not_found' }, 404);
      const sessionId = context.req.param('sessionId');
      const repo = new MessagesRepo(dbForDir(entry.path, isActive).sqlite);
      const { before, limit } = context.req.valid('query');
      // raw 行原样下发(blocks_json 不 parse),keyset 分页。
      const messages = before === undefined
        ? repo.listForSession(sessionId, limit)
        : repo.listBefore(sessionId, before, limit);
      return context.json({ messages });
    });
};

function registryError(context: Context, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('cannot remove the only')) {
    return context.json({ error: 'cannot_remove_last' }, 409);
  }
  if (message.includes('not found')) {
    return context.json({ error: 'dir_not_found' }, 404);
  }
  return context.json({ error: 'registry_error', message }, 400);
}
