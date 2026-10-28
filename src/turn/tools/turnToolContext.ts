import { BuiltinTools, type AskUser, type ToolUseContext } from '@ema-agent/tools';
import type { TurnToolsDeps, PrepareTurnToolsInput } from './turnTools.js';

export async function createTurnToolContext(
  deps: TurnToolsDeps,
  input: PrepareTurnToolsInput,
  askUser: AskUser,
): Promise<ToolUseContext> {
  const { sessionId, turnId, cwd, scratchpadDir } = input;
  const fileStateCache = deps.fileStateCache(sessionId);
  // Plan 或未启用 Bash 时不等待 Shell 探测. start 只负责启动已经准备好的命令.
  const commandRunner = input.toolPool.get(BuiltinTools.Bash.name)
    ? await deps.commandRunner?.(cwd, input.workspaceRoots)
    : undefined;
  input.signal.throwIfAborted();
  const vision = deps.resolveVision?.();
  const narrativeSearch = deps.resolveNarrativeSearch?.(sessionId, turnId);
  const toolContext: ToolUseContext = Object.freeze({
    cwd,
    platform: process.platform,
    ...(commandRunner ? { commandRunner } : {}),
    ...(vision ? { vision } : {}),
    ...(deps.captureScreen ? { captureScreen: deps.captureScreen } : {}),
    ...(deps.computerUse ? { computerUse: deps.computerUse } : {}),
    ...(deps.backgroundProcesses ? { backgroundProcesses: deps.backgroundProcesses } : {}),
    ...(narrativeSearch ? { narrativeSearch } : {}),
    ...(deps.memorySearch ? { memorySearch: deps.memorySearch } : {}),
    ...(deps.memoryRead ? { memoryRead: deps.memoryRead } : {}),
    ...(deps.memoryList ? { memoryList: deps.memoryList } : {}),
    ...(deps.taskStore ? { taskStore: deps.taskStore } : {}),
    ...(deps.goalStore ? { goalStore: deps.goalStore } : {}),
    subagents: {
      start: (
        prompt,
        options,
        toolCallId,
        runInBackground,
        signal
      ) => deps.subagents.start({
        sessionId,
        parentTurnId: turnId,
        toolCallId,
        prompt,
        options,
        permissionMode: input.permission.mode,
        reasoningEffort: input.reasoningEffort,
        prepareSubagent: input.prepareSubagent,
        parentSignal: signal,
        runInBackground,
        ...(input.onSubagentLLMCallFinished ? { onLLMCallFinished: input.onSubagentLLMCallFinished } : {}),
      }),
      waitForInitialResult: (subagentId, signal) =>
        deps.subagents.waitForInitialResult(subagentId, sessionId, signal),
      moveToBackground: subagentId => deps.subagents.moveToBackground(subagentId, sessionId),
      awaitResult: (subagentId, signal) => deps.subagents.awaitResult(subagentId, sessionId, signal),
      cancel: subagentId => deps.subagents.cancel(subagentId, sessionId),
    },
    ...(input.skillPool ? { skillPool: input.skillPool } : {}),
    ...(scratchpadDir ? { scratchpad: { dir: scratchpadDir, author: 'main' } } : {}),
    fileStateCache,
    askUser,
  });

  return toolContext;
}
