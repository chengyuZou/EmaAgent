// 把 Session、附件、统计与笔记入口装配成统一的 Session 备份能力。

import type { AttachmentStorePort } from '@ema-agent/attachment';
import { SessionBackupFacade } from '@ema-agent/backup';
import { asSessionId } from '@ema-agent/ids';
import type { SessionStore } from '@ema-agent/session';
import type {
  SessionNotesRepo,
  SessionStatsRepo,
} from '@ema-agent/storage';

export function createSessionBackup(
  activeDataDir: string,
  session: SessionStore,
  sessionStats: SessionStatsRepo,
  sessionNotes: SessionNotesRepo,
  attachments: Pick<AttachmentStorePort, 'listBySession'>,
): SessionBackupFacade {
  return new SessionBackupFacade({
    activeDataDir,
    sessionExists: sessionId =>
      session.sessionExists(asSessionId(sessionId)),
    restoreRows: payload => sessionStats.restoreRows(payload),
    collectExport: sessionId => {
      const id = asSessionId(sessionId);
      if (!session.sessionExists(id)) return null;

      const sessionRow = session.getSession(id);
      const noteRow = sessionNotes.findBySession(id);
      return {
        session: { ...sessionRow },
        turns: session.listTurns(id, 10_000),
        messages: session.listMessages(id, { limit: 10_000 }),
        attachments: attachments.listBySession(sessionId),
        audio: sessionStats.listAudioEntries(sessionId),
        notes: noteRow ? {
          sessionId,
          body: noteRow.body,
          tokensAtLastUpdate: noteRow.tokens_at_last_update,
          updatedAt: noteRow.updated_at,
        } : null,
        tasks: sessionStats.listTasks(sessionId),
        taskDependencies: sessionStats.listTaskDependencies(sessionId),
        agentRuns: sessionStats.listAgentRuns(sessionId),
        agentRunMessages: sessionStats.listAgentRunMessages(sessionId),
        memoryState: sessionStats.getMemoryState(sessionId) ?? null,
        kbActivations: sessionStats.listKbActivations(sessionId),
        usageRecords: sessionStats.listUsageRecords(sessionId),
      };
    },
  });
}
