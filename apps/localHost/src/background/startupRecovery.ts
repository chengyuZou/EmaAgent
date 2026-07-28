// 集中恢复异常退出留下的运行状态与孤儿文件，再交给常驻后台任务继续处理。

import type { AgentRunStore } from '@ema-agent/agent';
import { cleanupInterruptedFileWriteTemps } from '@ema-agent/tool-builtin';
import type { MemoryPlanner } from '@ema-agent/memory';
import type { SessionStore } from '@ema-agent/session';
import type { TurnIdPage, TurnIdPageCursor } from '@ema-agent/storage';
import type { ToolExecutionJournal } from '@ema-agent/tools';
import type { SessionId } from '@ema-agent/ids';
import {
  removeLegacyArtifactDirectories,
  sweepOrphanTurnFiles,
} from '../storage-locations/index.js';

type StartupMemory = Pick<MemoryPlanner, 'runStartupRecovery'>;
type StartupSession = Pick<SessionStore, 'listTurnIdsPage' | 'recoverStuckTurns'>;
type StartupAgentRuns = Pick<AgentRunStore, 'recoverInterrupted'>;
type StartupToolExecutions = Pick<ToolExecutionJournal, 'recoverInterrupted'>;

export interface StartupTurnReader {
  listTurnIdsPage(
    sessionId: SessionId,
    cursor?: TurnIdPageCursor,
    limit?: number,
  ): TurnIdPage;
}

export class StartupRecovery {
  constructor(
    private readonly activeDataDir: string,
    private readonly memory: StartupMemory,
    private readonly session: StartupSession,
    private readonly agentRuns: StartupAgentRuns,
    private readonly toolExecutions: StartupToolExecutions,
  ) {}

  run(): void {
    this.recoverToolExecutions();
    this.recoverMemory();
    this.recoverTurns();
    this.recoverTurnFiles();
    this.removeLegacyArtifactFiles();
    this.recoverAgentRuns();
  }

  private recoverToolExecutions(): void {
    try {
      const interrupted = this.toolExecutions.recoverInterrupted();
      const fileWriteRecovery = cleanupInterruptedFileWriteTemps(interrupted);
      if (interrupted.length > 0) {
        const unknownCount = interrupted.filter(
          execution => execution.status === 'outcome_unknown',
        ).length;
        console.warn(
          `[tool-execution] recovered ${interrupted.length} interrupted calls; `
          + `${unknownCount} may have produced side effects`,
        );
      }
      if (fileWriteRecovery.failed.length > 0) {
        console.warn(
          `[FileWriteTool] failed to remove ${fileWriteRecovery.failed.length} interrupted temporary files`,
        );
      }
      if (fileWriteRecovery.removed.length > 0) {
        console.info(
          `[FileWriteTool] removed ${fileWriteRecovery.removed.length} interrupted temporary files`,
        );
      }
    } catch (error) {
      console.warn('[tool-execution] startup recovery skipped:', error);
    }
  }

  private recoverMemory(): void {
    try {
      const report = this.memory.runStartupRecovery();
      if (report.resetTasks > 0) {
        console.log(`[memory] startup: reset ${report.resetTasks} stuck task(s)`);
      }
      if (report.orphanLazyUpdates > 0) {
        console.log(
          `[memory] startup: cleaned ${report.orphanLazyUpdates} orphan lazy_update(s)`,
        );
      }
      if (report.staleNodeEmbeds + report.staleItemEmbeds > 0) {
        console.warn(
          `[memory] startup: ${report.staleNodeEmbeds} stale node embeds, `
          + `${report.staleItemEmbeds} stale item embeds (provider may have changed)`,
        );
      }
      if (report.pendingSessions > 0) {
        console.log(
          `[memory] startup: ${report.pendingSessions} session(s) have pending fragments`,
        );
      }
    } catch (error) {
      console.warn('[memory] startup recovery skipped:', error);
    }
  }

  private recoverTurns(): void {
    try {
      const { healed } = this.session.recoverStuckTurns();
      if (healed > 0) {
        console.log(
          `[session] startup: aborted ${healed} stuck turn(s) from prior crash`,
        );
      }
    } catch (error) {
      console.warn('[session] startup turn recovery skipped:', error);
    }
  }

  private recoverTurnFiles(): void {
    try {
      const { removed } = sweepStartupOrphanTurnFiles(
        this.activeDataDir,
        this.session,
      );
      if (removed > 0) {
        console.log(
          `[session] startup: removed ${removed} orphan turn file entrie(s)`,
        );
      }
    } catch (error) {
      console.warn('[session] startup orphan turn file sweep skipped:', error);
    }
  }

  private removeLegacyArtifactFiles(): void {
    try {
      const removed = removeLegacyArtifactDirectories(this.activeDataDir);
      if (removed > 0) {
        console.log(
          `[session] startup: removed ${removed} legacy Artifact directories`,
        );
      }
    } catch (error) {
      console.warn('[session] startup legacy artifact cleanup skipped:', error);
    }
  }

  private recoverAgentRuns(): void {
    try {
      const recovered = this.agentRuns.recoverInterrupted();
      if (recovered.length > 0) {
        console.log(
          `[agent-run] startup: marked ${recovered.length} interrupted run(s) as failed`,
        );
      }
    } catch (error) {
      console.warn('[agent-run] startup recovery skipped:', error);
    }
  }
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
  return sweepOrphanTurnFiles(activeDataDir, sessionId =>
    collectLiveTurnIds(reader, sessionId as SessionId),
  );
}
