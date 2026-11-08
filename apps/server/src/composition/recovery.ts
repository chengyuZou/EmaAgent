import { logging } from '@ema-agent/logging';
import type { SubagentMessagesStore, SubagentStore } from '@ema-agent/agent';
import { cleanupInterruptedFileWriteTemps } from '@ema-agent/builtin-tools';
import { reconcileProjectRules } from '@ema-agent/permission';
import type { SessionStore } from '@ema-agent/session';
import type { SettingsStore } from '@ema-agent/settings';
import type { GoalStore } from '@ema-agent/goal';
import {
  ProjectsRepo,
  type Database,
} from '@ema-agent/storage';
import type {
  BackgroundProcess,
  ToolExecutionState,
} from '@ema-agent/tools';
import type { TurnStore } from '@ema-agent/turn';
import type { AudioStore } from '@ema-agent/speech';
import {
  sweepOrphanSessionDirectories,
  sweepOrphanTurnFiles,
} from '../platform/paths.js';

export interface StartupRecoveryDeps {
  readonly activeDataDir: string;
  readonly dataDb: Database;
  readonly session: SessionStore;
  readonly turns: TurnStore;
  readonly subagents: SubagentStore;
  readonly subagentMessages: SubagentMessagesStore;
  readonly toolExecutionState: ToolExecutionState;
  readonly backgroundProcesses: BackgroundProcess;
  readonly settings: SettingsStore;
  readonly goals: GoalStore;
  readonly audioStore: Pick<AudioStore, 'markInterruptedAudioRecordsFailed'>;
}

/**
 * Tool/Turn/Subagent/后台进程的终态恢复与项目规则对账是 ready 前置条件:
 * 失败必须向上传播,不能把旧 running 状态留给新进程.
 * Memory 的任务恢复由 openMemory 返回的 start() 在 ready 后执行.
 */
export function runRequiredRecovery(deps: StartupRecoveryDeps): void {
  deps.audioStore.markInterruptedAudioRecordsFailed();
  deps.goals.pauseActiveOnStartup();
  recoverToolExecutions(deps);
  const interruptedProcesses = deps.backgroundProcesses.recoverInterrupted();
  if (interruptedProcesses.length > 0) {
    logging({
      level: 'warn',
      target: 'recovery',
      event: 'recovery.processes_interrupted',
      body: { count: interruptedProcesses.length },
    });
  }
  const { healed } = deps.turns.recoverStuckTurns();
  if (healed > 0) {
    logging({
      level: 'warn',
      target: 'recovery',
      event: 'recovery.turns_closed',
      body: { count: healed },
    });
  }
  const interruptedRuns = deps.subagents.recoverInterrupted();
  if (interruptedRuns.length > 0) {
    logging({
      level: 'warn',
      target: 'recovery',
      event: 'recovery.subagents_interrupted',
      body: { count: interruptedRuns.length },
    });
  }

  // 项目规则对账:剔除已删除项目的规则键,防止 settings 里长孤儿.
  const projectIds = new ProjectsRepo(deps.dataDb.sqlite).list().map(row => row.id);
  reconcileProjectRules(deps.settings, projectIds);
}

/**
 * 中断的工具调用:缺 tool_result 的按状态合成终态消息补配对(running→outcome_unknown,
 * 其余→cancelled),再关账执行日志;FileWrite 的临时文件随调用清单清理.
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
    // 主 Agent 工具从 Session 历史查调用, 子 Agent 工具从各自转录查调用.
    // 两条链都先写 Message 再关执行状态, 所以恢复时可能已经存在 ToolResult.
    const childInteraction = execution.subagentId
      ? deps.subagentMessages.findToolInteraction(execution.subagentId, execution.callId)
      : undefined;
    const interaction = execution.subagentId
      ? childInteraction
      : deps.session.findToolInteraction(execution.turnId, execution.callId);
    if (!interaction) {
      throw new Error(`tool_call_message_missing: ${execution.callId}`);
    }
    const result = interaction.result ?? {
      type: 'tool_result' as const,
      toolCallId: execution.callId,
      content: execution.status === 'running'
        ? '软件异常退出时工具仍在运行,实际副作用未知.请先检查当前状态,不要直接重复执行.'
        : '软件异常退出前工具尚未开始执行,本次调用已取消.',
      isError: true,
      errorCode: execution.status === 'running' ? 'tool/outcome_unknown' : 'tool/cancelled',
    };
    if (!interaction.result) {
      if (execution.subagentId && childInteraction) {
        deps.subagentMessages.appendToolResult(execution.subagentId, childInteraction.runId, result);
      } else {
        deps.session.appendMessage({
          sessionId: execution.sessionId,
          turnId: execution.turnId,
          role: 'user',
          kind: 'tool_results',
          blocks: [result],
        });
      }
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
      logging({
        level: 'warn',
        target: 'recovery',
        event: 'recovery.tools_closed',
        body: { count: interrupted.length, unknownCount },
      });
    }
    if (fileWriteRecovery.failed.length > 0) {
      logging({
        level: 'warn',
        target: 'recovery',
        event: 'recovery.write_temps_failed',
        body: { count: fileWriteRecovery.failed.length },
      });
    }
  } catch (error) {
    // 终态已经恢复;临时文件清理属于可重试维护,不阻止启动.
    logging({
      level: 'warn',
      target: 'recovery',
      event: 'recovery.write_temps_skipped',
      error,
    });
  }
}

/** 孤儿文件清理失败只降级本轮清理,不阻断 ready. */
export function runFileMaintenance(deps: StartupRecoveryDeps): void {
  try {
    const { removed, failed } = sweepOrphanSessionDirectories(
      deps.activeDataDir,
      sessionId => deps.session.sessionExists(sessionId),
    );
    if (removed > 0) {
      logging({
        level: 'info',
        target: 'recovery',
        event: 'recovery.session_dirs_cleaned',
        body: { count: removed },
      });
    }
    if (failed > 0) {
      logging({
        level: 'warn',
        target: 'recovery',
        event: 'recovery.session_dirs_failed',
        body: { count: failed },
      });
    }
  } catch (error) {
    logging({
      level: 'warn',
      target: 'recovery',
      event: 'recovery.session_dirs_skipped',
      error,
    });
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
    if (removed > 0) {
      logging({
        level: 'info',
        target: 'recovery',
        event: 'recovery.turn_files_cleaned',
        body: { count: removed },
      });
    }
  } catch (error) {
    logging({
      level: 'warn',
      target: 'recovery',
      event: 'recovery.turn_files_skipped',
      error,
    });
  }

}
