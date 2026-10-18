import { Hono } from 'hono';
import {
  DataDirStatsRepo,
  SessionStatsRepo,
} from '@ema-agent/storage';

export interface StorageStatsRouteDeps {
  readonly dataDirStats: Pick<DataDirStatsRepo, 'getStats'>;
  readonly sessionStats: Pick<SessionStatsRepo, 'getStats'>;
}

/** 只返回数量和合计值. 目录, 消息正文和媒体内容由各自的读取路由提供. */
export const storageStatsRoute = (deps: StorageStatsRouteDeps) =>
  new Hono()
    .get('/', context => context.json(deps.dataDirStats.getStats()))
    .get('/sessions/:sessionId', context => {
      return context.json(deps.sessionStats.getStats(context.req.param('sessionId')));
    });
