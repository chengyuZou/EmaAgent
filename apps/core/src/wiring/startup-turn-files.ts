// 启动时通过 Session Facade 全量读取存活 Turn，并清理数据库已删除但磁盘仍残留的文件。
import type { SessionId } from '@ema-agent/contracts';
import type { TurnIdPage, TurnIdPageCursor } from '@ema-agent/storage';
import { sweepOrphanTurnFiles } from '../storage-locations/index.js';

export interface StartupTurnReader {
  listTurnIdsPage(
    sessionId: SessionId,
    cursor?: TurnIdPageCursor,
    limit?: number,
  ): TurnIdPage;
}

export function collectLiveTurnIds(
  reader: StartupTurnReader,
  sessionId: SessionId,
): Set<string> {
  const ids = new Set<string>();
  let cursor: TurnIdPageCursor | undefined;
  do {
    const page = reader.listTurnIdsPage(sessionId, cursor);
    for (const id of page.ids) ids.add(id);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return ids;
}

export function sweepStartupOrphanTurnFiles(
  activeDataDir: string,
  reader: StartupTurnReader,
): { removed: number } {
  return sweepOrphanTurnFiles(activeDataDir, (sessionId) =>
    collectLiveTurnIds(reader, sessionId as SessionId),
  );
}
