import type { SubagentExecutor, AgentLoopEvent, PrepareSubagent } from '@ema-agent/agent';
import type { CallVision } from '@ema-agent/vision';
import {
  type PermissionMode,
  type PermissionStreamEvent,
  type PermissionContext,
} from '@ema-agent/permission';
import type { CommandRunner } from '@ema-agent/sandbox';
import type { SkillPool } from '@ema-agent/skills';
import type { TaskStore } from '@ema-agent/tasks';
import type { GoalStore } from '@ema-agent/goal';
import {
  ToolPool,
  type BackgroundProcess,
  type FileStateCache,
  StreamingToolExecutor,
  type ToolExecutionState,
  type AskUserEvent,
  type ToolResultStore,
  type ToolUseContext,
} from '@ema-agent/tools';
import type { ReasoningEffort } from '@ema-agent/session';
import type { SessionInteractionQueue } from '../interaction/sessionInteractionQueue.js';
import type { TurnStreamEvent } from '../events.js';
import { createTurnInteractions } from './turnInteractions.js';
import { createTurnToolContext } from './turnToolContext.js';
import { createComputerToolHooks } from './computerToolHooks.js';
import { restrictSubagentContext } from '../policy/subagentToolPolicy.js';

export interface TurnToolsDeps {
  readonly fileStateCache: (sessionId: string) => FileStateCache;
  readonly interactionQueue: SessionInteractionQueue;
  /** Session 的批准事件出口, 不依赖父 Turn 是否仍在运行. */
  readonly publishInteraction: (event: PermissionStreamEvent | AskUserEvent) => void;
  readonly subagents: SubagentExecutor;
  readonly taskStore?: TaskStore;
  readonly goalStore?: GoalStore;
  /** Turn 准备时冻结模型绑定与算法设置. 缺少绑定时, 调用剧情工具会返回执行环境不可用. */
  readonly resolveNarrativeSearch?: (sessionId: string, turnId: string) => ToolUseContext['narrativeSearch'];
  readonly memorySearch?: ToolUseContext['memorySearch'];
  readonly memoryRead?: ToolUseContext['memoryRead'];
  readonly memoryList?: ToolUseContext['memoryList'];
  readonly backgroundProcesses?: BackgroundProcess;
  /** 每 Turn 解析一次 vision 调用闭包: 无绑定时返回 undefined */
  readonly resolveVision?: () => CallVision | undefined;
  readonly captureScreen?: ToolUseContext['captureScreen'];
  readonly computerUse?: ToolUseContext['computerUse'];
  readonly commandRunner?: (
    cwd: string,
    workspaceRoots: readonly string[],
  ) => Promise<CommandRunner | undefined>;
  readonly toolResultStore?: (sessionId: string) => ToolResultStore;
  readonly toolExecutionState?: ToolExecutionState;
}

export interface PrepareTurnToolsInput {
  readonly toolPool: ToolPool;
  readonly sessionId: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly workspaceRoots: readonly string[];
  readonly scratchpadDir?: string;
  readonly skillPool?: SkillPool;
  readonly prepareSubagent: PrepareSubagent;
  readonly reasoningEffort: ReasoningEffort;
  readonly emit: (event: TurnStreamEvent) => void;
  /** 子 Agent 的物理调用不经过主 AgentLoop, 由 Turn 注入同一本账的终态出口 */
  readonly onSubagentLLMCallFinished?: (
    event: Extract<AgentLoopEvent, { type: 'llm_call_finished' }>,
  ) => void;
  readonly permission: {
    readonly mode: PermissionMode;
    readonly rules: PermissionContext['rules'];
  };
  readonly signal: AbortSignal;
}

export interface TurnToolsAssembly {
  readonly toolPool: ToolPool;
  readonly createExecutor: (wake: () => void) => StreamingToolExecutor;
  /** 子代理使用独立工具池, 批准请求按本次 Run 归属, 共用 Session FIFO. */
  readonly createSubagentExecutor: (args: {
    subagentId: string;
    runId: string;
    toolPool: ToolPool;
    signal: AbortSignal;
    wake: () => void;
  }) => StreamingToolExecutor;
  readonly abortTool: (toolCallId: string) => boolean;
  /**
   * Turn 收尾时调用, 等当前工具执行器停止, 再取消并等待本 Turn 的前台子代理.
   * 电脑操控由 finishTurn 在每种 Turn 结束路径中关闭, 不依赖本装配是否已经创建.
   * 重复调用不再次发起关闭.
   */
  readonly shutdown: (reason: string) => Promise<void>;
}

export async function prepareTurnTools(deps: TurnToolsDeps, input: PrepareTurnToolsInput): Promise<TurnToolsAssembly> {
  const { sessionId, turnId } = input;

  const permissionContext: PermissionContext = {
    mode: input.permission.mode,
    sessionId,
    rules: input.permission.rules,
    workspaceRoots: input.workspaceRoots,
  };

  const { askPermission, askUser } = createTurnInteractions(deps, input);
  const toolContext = await createTurnToolContext(deps, input, askUser);

  // 禁用设置按 Turn 冻结, 模型和执行器使用同一个筛选结果. 运行中改开关只影响下一 Turn.
  const toolPool = input.toolPool;

  const toolResultStore = deps.toolResultStore?.(sessionId);
  const subagentToolContext = restrictSubagentContext(toolContext);
  let currentExecutor: StreamingToolExecutor | undefined;
  const createExecutor = (wake: () => void): StreamingToolExecutor => {
    const executor = new StreamingToolExecutor({
      sessionId,
      turnId,
      abortSignal: input.signal,
      toolPool,
      permissionContext,
      askPermission,
      toolContext,
      toolResultStore,
      // 只有主 Agent 登记电脑调用. 子代理使用下方不带这些回调的执行器.
      ...createComputerToolHooks(deps.computerUse, sessionId, turnId),
      ...(deps.toolExecutionState ? { toolExecutionState: deps.toolExecutionState } : {}),
      // 工具结果要等 Message 保存后再发布. 此处只转发进度,
      // tool_result 由 turnLoopEvents 读取已保存的 AgentLoop 事件生成.
      publishEvent: event => {
        if (event.type === 'tool_progress') {
          input.emit(event);
        }
      },
      wake,
    });
    currentExecutor = executor;
    return executor;
  };

  let stopped = false;
  return {
    toolPool,
    createExecutor,
    createSubagentExecutor: ({ subagentId, runId, toolPool: subPool, signal, wake }) => {
      const scratchpad = subagentToolContext.scratchpad;
      const executor = new StreamingToolExecutor({
        sessionId,
        turnId,
        subagentId,
        runId,
        abortSignal: signal,
        toolPool: subPool,
        permissionContext,
        askPermission,
        toolContext: {
          ...subagentToolContext,
          // 主/子代理共用目录, 写入者随当前子代理绑定, 不修改主 Agent 的上下文.
          ...(scratchpad ? {
            scratchpad: { dir: scratchpad.dir, author: `subagent:${subagentId}` },
          } : {}),
        },
        toolResultStore,
        ...(deps.toolExecutionState ? { toolExecutionState: deps.toolExecutionState } : {}),
        // 子代理终态由 SubagentExecutor 在 ToolResult 写入 transcript 后发布;
        // 这里只实时转发执行进度和交互事件.
        publishEvent: event => {
          // 子代理进度通过自己的 Session 事件发布, 不写进父 Turn.
          if (event.type === 'tool_progress') {
            deps.subagents.publishToolProgress(
              sessionId,
              subagentId,
              runId,
              event
            );
          }
        },
        wake,
      });
      return executor;
    },
    abortTool: toolCallId => currentExecutor?.abortTool(toolCallId) ?? false,
    shutdown: async reason => {
      if (stopped) return;
      stopped = true;
      // 等当前工具退出或达到关闭等待期限. 子代理有独立的取消和收尾, 需要下一步单独处理.
      await currentExecutor?.shutdown(reason);
      // 只等本 Turn 的前台子代理收尾, 已转后台的 Run 由子代理执行器独立管理.
      await deps.subagents.abortForegroundForTurn(turnId);
    },
  };
}
