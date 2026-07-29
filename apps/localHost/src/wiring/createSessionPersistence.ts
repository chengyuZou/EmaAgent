// 装配 Session 聚合、统计与会话笔记使用的 Data DB 持久入口。

import type { Database } from '@ema-agent/storage';
import {
  DataDirStatsRepo,
  SessionNotesRepo,
  SessionStatsRepo,
} from '@ema-agent/storage';
import { SessionStore } from '@ema-agent/session';
import {
  removeSessionDir,
  removeTurnFiles,
} from '../storage-locations/index.js';

export function createSessionPersistence(
  dataDb: Database,
  activeDataDir: string,
) {
  const session = new SessionStore({
    db: dataDb,
    // 数据库行由外键级联，音频、Scratchpad 等派生文件必须显式清理。
    onSessionRemoved: sessionId =>
      removeSessionDir(activeDataDir, sessionId),
    onTurnRemoved: (sessionId, turnId) =>
      removeTurnFiles(activeDataDir, sessionId, turnId),
  });

  return {
    session,
    sessionStats: new SessionStatsRepo(dataDb.sqlite),
    storageStats: new DataDirStatsRepo(dataDb.sqlite),
    // Memory、Session Dashboard 与 Backup 必须共享同一会话笔记入口。
    sessionNotes: new SessionNotesRepo(dataDb.sqlite),
  };
}
