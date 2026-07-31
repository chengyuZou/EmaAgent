// 把 data.db 的流式快照与原子恢复能力装配成 Session 备份入口。
import { SessionBackupFacade } from '@ema-agent/backup';
import { asSessionId } from '@ema-agent/ids';
import type { SessionStore } from '@ema-agent/session';
import {
  SessionBackupReader,
  SessionBackupRestorer,
  type Database,
} from '@ema-agent/storage';

export function createSessionBackup(
  activeDataDir: string,
  dataDb: Database,
  session: SessionStore,
): SessionBackupFacade {
  return new SessionBackupFacade({
    activeDataDir,
    reader: new SessionBackupReader(dataDb.sqlite),
    restorer: new SessionBackupRestorer(dataDb.sqlite),
    sessionExists: sessionId => session.sessionExists(asSessionId(sessionId)),
  });
}
