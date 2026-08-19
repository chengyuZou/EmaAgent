// 启动恢复：崩溃残留的终态收口（ready 前置）、孤儿文件清理（可降级）与权限项目规则对账。
import type { AgentRunStore } from '@ema-agent/agent';
import { cleanupInterruptedFileWriteTemps } from '@ema-agent/builtin-tools';
import { reconcileProjectRules } from '@ema-agent/permission';
import type { SessionStore } from '@ema-agent/session';
import type { SettingsStore } from '@ema-agent/settings';
import {
  ProjectsRepo,
  type Database,
} from '@ema-agent/storage';
import type {
  BackgroundProcess,
  ToolExecutionState,
} from '@ema-agent/tools';
import type { TurnStore } from '@ema-agent/turn';
import {
  removeLegacyArtifactDirectories,
  sweepOrphanSessionDirectories,
  sweepOrphanTurnFiles,
} from '../platform/paths.js';

export interface StartupRecoveryDeps {
  readonly activeDataDir: string;
  readonly dataDb: Database;
  readonly session: SessionStore;
  readonly turns: TurnStore;
  readonly agentRuns: AgentRunStore;
  readonly toolExecutionState: ToolExecutionState;
  readonly backgroundProcesses: BackgroundProcess;
  readonly settings: SettingsStore;
}

/**
 * Tool/Turn/AgentRun/后台进程的终态恢复与项目规则对账是 ready 前置条件：
 * 失败必须向上传播，不能把旧 running 状态留给新进程。
 * Memory 的启动恢复归 Sol 的 Memory 包收口后接入。
 */
export function runRequiredRecovery(deps: StartupRecoveryDeps): void {
  recoverToolExecutions(deps);
  const interruptedProcesses = deps.backgroundProcesses.recoverInterrupted();
  if (interruptedProcesses.length > 0) {
    console.warn(`[recovery] 标记 ${interruptedProcesses.length} 个中断后台进程`);
  }
  const { healed } = deps.turns.recoverStuckTurns();
  if (healed > 0) {
    console.warn(`[recovery] 收口 ${healed} 个崩溃残留 Turn`);
  }
  const interruptedRuns = deps.agentRuns.recoverInterrupted();
  if (interruptedRuns.length > 0) {
    console.warn(`[recovery] 标记 ${interruptedRuns.length} 个中断 AgentRun`);
  }

  // 项目规则对账：剔除已删除项目的规则键，防止 settings 里长孤儿。
  const projectIds = new ProjectsRepo(deps.dataDb.sqlite).list().map(row => row.id);
  reconcileProjectRules(deps.settings, projectIds);
}

/**
 * 中断的工具调用：缺 tool_result 的按状态合成终态消息补配对（running→outcome_unknown，
 * 其余→cancelled），再关账执行日志；FileWrite 的临时文件随调用清单清理。
 */
function recoverToolExecutions(deps: StartupRecoveryDeps): void {
  const interrupted = deps.toolExecutionState.listInterrupted();
  const fileWriteCalls: Array<{
    callId: string;
    toolName: string;
    args: unknown;
    outcomeUnknown: boolean;
  }> = [];
  for (const execution of interrupted) {
    const interaction = deps.session.findToolInteraction(execution.turnId, execution.callId);
    if (!interaction) {
      throw new Error(`tool_call_message_missing: ${execution.callId}`);
    }
    const result = interaction.result ?? {
      type: 'tool_result' as const,
      toolCallId: execution.callId,
      content: execution.status === 'running'
        ? '软件异常退出时工具仍在运行，实际副作用未知。请先检查当前状态，不要直接重复执行。'
        : '软件异常退出前工具尚未开始执行，本次调用已取消。',
      isError: true,
      errorCode: execution.status === 'running' ? 'tool/outcome_unknown' : 'tool/cancelled',
    };
    if (!interaction.result) {
      deps.session.appendMessage({
        sessionId: execution.sessionId,
        turnId: execution.turnId,
        role: 'user',
        kind: 'tool_results',
        blocks: [result],
      });
    }
    deps.toolExecutionState.completeFromMessage(execution.callId, result);
    fileWriteCalls.push({
      callId: execution.callId,
      toolName: interaction.name,
      args: interaction.args,
      outcomeUnknown: result.errorCode === 'tool/outcome_unknown',
    });
  }
  try {
    const fileWriteRecovery = cleanupInterruptedFileWriteTemps(fileWriteCalls);
    if (interrupted.length > 0) {
      const unknownCount = fileWriteCalls.filter(call => call.outcomeUnknown).length;
      console.warn(
        `[recovery] 恢复 ${interrupted.length} 个中断工具调用；${unknownCount} 个副作用未知`,
      );
    }
    if (fileWriteRecovery.failed.length > 0) {
      console.warn(`[recovery] ${fileWriteRecovery.failed.length} 个 FileWrite 临时文件清理失败`);
    }
  } catch (error) {
    // 终态已经恢复；临时文件清理属于可重试维护，不阻止启动。
    console.warn('[recovery] FileWrite 临时文件清理跳过:', error);
  }
}

/** 孤儿文件清理失败只降级本轮清理，不阻断 ready。 */
export function runFileMaintenance(deps: StartupRecoveryDeps): void {
  try {
    const { removed, failed } = sweepOrphanSessionDirectories(
      deps.activeDataDir,
      sessionId => deps.session.sessionExists(sessionId),
    );
    if (removed > 0) console.warn(`[recovery] 清理 ${removed} 个孤儿 Session 目录`);
    if (failed > 0) console.warn(`[recovery] ${failed} 个孤儿 Session 目录删除失败`);
  } catch (error) {
    console.warn('[recovery] 孤儿 Session 目录清理跳过:', error);
  }

  try {
    const { removed } = sweepOrphanTurnFiles(deps.activeDataDir, sessionId => {
      const ids = new Set<string>();
      let cursor;
      do {
        const page = deps.turns.listTurnIdsPage(sessionId, cursor);
        for (const id of page.ids) ids.add(id);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return ids;
    });
    if (removed > 0) console.warn(`[recovery] 清理 ${removed} 个孤儿 Turn 文件`);
  } catch (error) {
    console.warn('[recovery] 孤儿 Turn 文件清理跳过:', error);
  }

  try {
    removeLegacyArtifactDirectories(deps.activeDataDir);
  } catch (error) {
    console.warn('[recovery] 旧 Artifact 目录清理跳过:', error);
  }
}
