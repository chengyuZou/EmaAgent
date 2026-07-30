// 区分必须完成的执行状态恢复与可降级维护，避免带着错误终态对外 ready。

import type { AgentRunStore } from '@ema-agent/agent';
import { cleanupInterruptedFileWriteTemps } from '@ema-agent/tool-builtin';
import type { MemoryPlanner } from '@ema-agent/memory';
import type { SessionStore } from '@ema-agent/session';
import type { TurnIdPage, TurnIdPageCursor } from '@ema-agent/storage';
import type {
  BackgroundProcessRuntime,
  ToolExecutionJournal,
} from '@ema-agent/tools';
import type { SessionId } from '@ema-agent/ids';
import {
  removeLegacyArtifactDirectories,
  sweepOrphanSessionDirectories,
  sweepOrphanTurnFiles,
} from '../storage-locations/index.js';

type StartupMemory = Pick<MemoryPlanner, 'runStartupRecovery'>;
type StartupSession = Pick<
  SessionStore,
  'listTurnIdsPage' | 'recoverStuckTurns' | 'sessionExists'
>;
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
    private readonly backgroundProcesses: Pick<
      BackgroundProcessRuntime,
      'recoverInterrupted'
    >,
  ) {}

  /**
   * Tool、Turn 与 AgentRun 的终态是继续接收请求的前置条件。
   * 数据库恢复失败必须向上传播，不能把旧 running 状态留给新进程。
   */
  runRequired(): void {
    this.recoverToolExecutions();
    this.recoverBackgroundProcesses();
    this.recoverTurns();
    this.recoverAgentRuns();
  }

  private recoverBackgroundProcesses(): void {
    const recovered = this.backgroundProcesses.recoverInterrupted();
    if (recovered.length > 0) {
      console.log(
        `[background-process] startup: marked ${recovered.length} process(es) as interrupted`,
      );
    }
  }

  /**
   * Memory 与孤儿文件清理失败只降级对应后台能力。
   * 返回值决定本次进程是否可以启动 Memory Worker。
   */
  runMaintenance(): { memoryReady: boolean } {
    const memoryReady = this.recoverMemory();
    this.recoverSessionDirectories();
    this.recoverTurnFiles();
    this.removeLegacyArtifactFiles();
    return { memoryReady };
  }

  private recoverToolExecutions(): void {
    const interrupted = this.toolExecutions.recoverInterrupted();
    try {
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
      // Tool 终态已经恢复；临时文件清理属于可重试维护，不阻止启动。
      console.warn('[tool-execution] temporary file cleanup skipped:', error);
    }
  }

  private recoverMemory(): boolean {
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
      return true;
    } catch (error) {
      console.warn('[memory] startup recovery skipped:', error);
      return false;
    }
  }

  private recoverTurns(): void {
    const { healed } = this.session.recoverStuckTurns();
    if (healed > 0) {
      console.log(
        `[session] startup: aborted ${healed} stuck turn(s) from prior crash`,
      );
    }
  }

  private recoverSessionDirectories(): void {
    try {
      const { removed, failed } = sweepOrphanSessionDirectories(
        this.activeDataDir,
        sessionId => this.session.sessionExists(sessionId as SessionId),
      );
      if (removed > 0) {
        console.log(
          `[session] startup: removed ${removed} orphan Session director${removed === 1 ? 'y' : 'ies'}`,
        );
      }
      if (failed > 0) {
        console.warn(
          `[session] startup: failed to remove ${failed} orphan Session director${failed === 1 ? 'y' : 'ies'}`,
        );
      }
    } catch (error) {
      console.warn('[session] startup orphan session sweep skipped:', error);
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
    const recovered = this.agentRuns.recoverInterrupted();
    if (recovered.length > 0) {
      console.log(
        `[agent-run] startup: marked ${recovered.length} interrupted run(s) as failed`,
      );
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
