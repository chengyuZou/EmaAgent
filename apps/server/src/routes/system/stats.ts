// 存储统计：数据目录总量与单 Session 明细；只读投影，不承担写入。
import { Hono } from 'hono';
import {
  DataDirStatsRepo,
  SessionStatsRepo,
} from '@ema-agent/storage';

export interface SystemStatsRouteDeps {
  readonly dataDirStats: Pick<DataDirStatsRepo, 'getStats'>;
  readonly sessionStats: Pick<SessionStatsRepo, 'getStats'>;
}

export function systemStatsRoute(deps: SystemStatsRouteDeps): Hono {
  const app = new Hono();

  app.get('/stats', context => context.json(deps.dataDirStats.getStats()));

  app.get('/stats/sessions/:id', context => {
    return context.json(deps.sessionStats.getStats(context.req.param('id')));
  });

  return app;
}
