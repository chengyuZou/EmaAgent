// 为一次 Turn 冻结工具层: ToolPool 宿主能力上下文 权限判定上下文与两类交互口子
import type { SubagentExecutor, AgentLoopEvent, PrepareSubagent } from '@ema-agent/agent';
import type { KnowledgeSearch } from '@ema-agent/knowledge';
import type { CallVision } from '@ema-agent/vision';
import type { NarrativeClient, NarrativeLlmConnection, NarrativeSearch } from '@ema-agent/narrative';
import { narrativeQueryModeSetting, prepareNarrativeRecall } from '@ema-agent/narrative';
import {
  applyPermissionUpdate,
  type PermissionMode,
  type PermissionRequest,
  type PermissionResponse,
  type PermissionStreamEvent,
  type ToolPermissionContext,
} from '@ema-agent/permission';
import type { CommandRunner } from '@ema-agent/sandbox';
import type { SettingsStore } from '@ema-agent/settings';
import type { SkillPool } from '@ema-agent/skills';
import type { TaskStore } from '@ema-agent/tasks';
import type { GoalStore } from '@ema-agent/goal';
import {
  assembleToolPool,
  BuiltinTools,
  ToolPool,
  type AskUser,
  type AskUserRequiredEvent,
  type BackgroundProcess,
  type ReadFileState,
  StreamingToolExecutor,
  type ToolExecutionState,
  type ToolExecutionEvent,
  type ToolRegistry,
  type ToolResultStore,
  type ToolUseContext,
} from '@ema-agent/tools';
import type { SessionMode, NarrativePolicy, ReasoningEffort } from '@ema-agent/session';
import type { TurnKnowledgeSelection } from '../types.js';
import type { SessionInteractionQueue } from '../interactionQueue.js';
import type { TurnStreamEvent } from '../events.js';

// Plan 只暴露整项能力均只读的工具. isReadOnly(input) 依赖尚未生成的参数,
// 不能用于装配筛选; Shell, 子代理和用户交互不作为只读例外放行.
const PLAN_TOOL_IDS: ReadonlySet<string> = new Set([
  BuiltinTools.FileRead.id,
  BuiltinTools.PdfRead.id,
  BuiltinTools.Glob.id,
  BuiltinTools.Grep.id,
  BuiltinTools.WebFetch.id,
  BuiltinTools.WebSearch.id,
  BuiltinTools.ProcessList.id,
  BuiltinTools.ProcessOutput.id,
  BuiltinTools.TaskGet.id,
  BuiltinTools.TaskList.id,
  BuiltinTools.KnowledgeBaseSearch.id,
  BuiltinTools.NarrativeSearch.id,
  BuiltinTools.MemorySearch.id,
  BuiltinTools.MemoryRead.id,
  BuiltinTools.MemoryList.id,
  BuiltinTools.Skill.id,
  BuiltinTools.ScratchpadRead.id,
  BuiltinTools.ScratchpadList.id,
]);

export interface TurnToolsDeps {
  readonly registry: ToolRegistry;
  readonly interactionQueue: SessionInteractionQueue;
  /** Session 的批准事件出口, 不依赖父 Turn 是否仍在运行. */
  readonly publishInteraction: (event: PermissionStreamEvent | Extract<ToolExecutionEvent, { type: 'ask_user_required' | 'ask_user_resolved' }>) => void;
  readonly settings: SettingsStore;
  readonly subagents: SubagentExecutor;
  readonly taskStore?: TaskStore;
  readonly goalStore?: GoalStore;
  readonly knowledgeSearch?: KnowledgeSearch;
  /** narrativePolicy 非 'off' 时构建本 Turn 召回闭包; 与 resolveNarrativeLlm 同时缺失则无 Narrative 能力 */
  readonly currentNarrativeClient?: () => NarrativeClient | undefined;
  /** Turn 开始时解析一次当次 Narrative LLM 连接并冻结进闭包: 未绑定或协议不支持返回 undefined */
  readonly resolveNarrativeLlm?: () => NarrativeLlmConnection | undefined;
  readonly backgroundProcesses?: BackgroundProcess;
  /** 每 Turn 解析一次 vision 调用闭包: 无绑定时返回 undefined */
  readonly resolveVision?: () => CallVision | undefined;
  readonly commandRunner?: (
    cwd: string,
    workspaceRoots: readonly string[],
  ) => CommandRunner | undefined;
  readonly toolResultStore?: (sessionId: string) => ToolResultStore;
  readonly toolExecutionState?: ToolExecutionState;
}

export interface PrepareTurnToolsInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly sessionMode: SessionMode;
  readonly narrativePolicy: NarrativePolicy;
  readonly cwd: string;
  readonly workspaceRoots: readonly string[];
  readonly scratchpadDir?: string;
  readonly skillPool?: SkillPool;
  /** 本 Turn 在当前激活知识库内冻结的文档范围 */
  readonly knowledge?: TurnKnowledgeSelection;
  readonly prepareSubagent: PrepareSubagent;
  readonly providerId: string;
  readonly modelId: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly emit: (event: TurnStreamEvent) => void;
  /** 子 Agent 的物理调用不经过根 AgentLoop, 由 Turn 注入同一本账的终态出口 */
  readonly onSubagentLlmCallFinished?: (
    event: Extract<AgentLoopEvent, { type: 'llm_call_finished' }>,
  ) => void;
  readonly permission: {
    readonly mode: PermissionMode;
    readonly buckets: {
      readonly alwaysAllowRules: ToolPermissionContext['alwaysAllowRules'];
      readonly alwaysDenyRules: ToolPermissionContext['alwaysDenyRules'];
      readonly alwaysAskRules: ToolPermissionContext['alwaysAskRules'];
    };
  };
  readonly signal: AbortSignal;
}

export interface TurnToolsAssembly {
  readonly toolPool: ToolPool;
  /** 本 Turn 冻结的召回闭包: auto 时进 Tool Context, always 时供 reminder: off 或无能力为 undefined */
  readonly narrativeSearch?: NarrativeSearch;
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
  readonly abortSubagent: (subagentId: string) => boolean;
  /** 根 Turn 终态前调用：先停工具再停子 Agent；幂等。 */
  readonly shutdown: (reason: string) => Promise<void>;
}

export function prepareTurnTools(deps: TurnToolsDeps, input: PrepareTurnToolsInput): TurnToolsAssembly {
  const {
    sessionId,
    turnId,
    cwd,
    scratchpadDir
  } = input;
  const readFileState: ReadFileState = new Map();

  const permissionContext: ToolPermissionContext = {
    mode: input.permission.mode,
    alwaysAllowRules: input.permission.buckets.alwaysAllowRules,
    alwaysDenyRules: input.permission.buckets.alwaysDenyRules,
    alwaysAskRules: input.permission.buckets.alwaysAskRules,
    workspaceRoots: input.workspaceRoots,
  };

  // 根 Agent 与前后台子代理共用这条 Session 交互通道.
  const askPermission = async (request: PermissionRequest, signal: AbortSignal): Promise<PermissionResponse> => {
    const { promise } = deps.interactionQueue.enqueuePermission(request);
    // 先建立可回答的队列条目, 再发布事件. 子代理不借父 Turn 通道.
    deps.publishInteraction({ type: 'permission_required', ...request });
    const response = await awaitInteraction(promise, signal, () => {
      deps.interactionQueue.cancel(request.toolCallId, 'tool aborted');
    });
    const resolved = {
      type: 'permission_resolved' as const,
      sessionId: request.sessionId,
      turnId: request.turnId,
      toolCallId: request.toolCallId,
      decision: response.action === 'deny' ? 'deny' as const : 'allow' as const,
    };
    if (request.subagentId !== undefined) {
      deps.publishInteraction({ ...resolved, subagentId: request.subagentId, runId: request.runId });
    } else {
      deps.publishInteraction(resolved);
    }
    if (response.action === 'allowSession' && request.ruleSuggestion) {
      applyPermissionUpdate(
        deps.settings,
        {
          type: 'addRules',
          destination: 'session',
          rules: [request.ruleSuggestion],
          behavior: 'allow',
        },
        { sessionId }
      );
    }
    return response;
  };

  const askUser: AskUser = async (toolCallId, specs, signal) => {
    const request: AskUserRequiredEvent = {
      type: 'ask_user_required',
      sessionId,
      turnId,
      toolCallId,
      questions: [...specs],
    };
    const { promise } = deps.interactionQueue.enqueueAskUser(request);
    deps.publishInteraction(request);
    const outcome = await awaitInteraction(promise, signal, () => {
      deps.interactionQueue.cancel(toolCallId, 'turn aborted');
    });
    // 取消/超时也要发空答案清前端卡片: 空答案 resolved 是清卡信号, 不是成功
    deps.publishInteraction({
      type: 'ask_user_resolved',
      sessionId,
      toolCallId,
      answers: outcome.status === 'answered' ? { ...outcome.answers } : {},
    });
    if (outcome.status === 'answered') {
      return { answers: { ...outcome.answers } };
    }
    throw new Error(`AskUser ${outcome.status}: ${outcome.reason}`);
  };

  const commandRunner = deps.commandRunner?.(cwd, input.workspaceRoots);
  const vision = deps.resolveVision?.();
  // 召回闭包在本 Turn 构建一次: LLM 连接与模式覆盖全部冻结;
  // auto 时模型经 Tool 触发, always 时 reminder 触发, 二者共用同一实现
  const narrativeSearch = ((): NarrativeSearch | undefined => {
    if (input.narrativePolicy === 'off') {
      return undefined;
    }
    if (!deps.currentNarrativeClient || !deps.resolveNarrativeLlm) {
      return undefined;
    }
    const client = deps.currentNarrativeClient();
    if (!client) {
      return undefined;
    }
    const llm = deps.resolveNarrativeLlm();
    if (!llm) {
      return undefined;
    }
    const queryModeOverride = deps.settings.get(narrativeQueryModeSetting);
    return (query, mode, signal) =>
      prepareNarrativeRecall(
        client,
        {
          sessionId,
          turnId,
          userInput: query,
          llm,
          mode: queryModeOverride !== 'auto' ? queryModeOverride : (mode ?? 'hybrid'),
          signal,
          emit: event => input.emit(event),
        }
      );
  })();
  const toolContext: ToolUseContext = Object.freeze({
    cwd,
    platform: process.platform,
    ...(commandRunner ? { commandRunner } : {}),
    ...(vision ? { vision } : {}),
    ...(deps.backgroundProcesses ? { backgroundProcesses: deps.backgroundProcesses } : {}),
    ...(deps.knowledgeSearch ? {
      knowledgeSearch: ((request) => deps.knowledgeSearch!({
        ...request,
        // Tool 显式给出 assetIds 时优先；否则继承本 Turn 冻结的文档范围。
        ...(request.assetIds === undefined && input.knowledge?.assetIds?.length ? { assetIds: [...input.knowledge.assetIds] } : {}),
      })) as KnowledgeSearch,
    } : {}),
    ...(input.narrativePolicy === 'auto' && narrativeSearch ? { narrativeSearch } : {}),
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
        ...(input.onSubagentLlmCallFinished ? { onLlmCallFinished: input.onSubagentLlmCallFinished } : {}),
      }),
      waitForInitialResult: (subagentId, signal) =>
        deps.subagents.waitForInitialResult(subagentId, sessionId, signal),
      moveToBackground: subagentId => deps.subagents.moveToBackground(subagentId, sessionId),
      awaitResult: (subagentId, signal) => deps.subagents.awaitResult(subagentId, sessionId, signal),
      cancel: subagentId => deps.subagents.cancel(subagentId, sessionId),
    },
    ...(input.skillPool ? { skillPool: input.skillPool } : {}),
    ...(scratchpadDir ? { scratchpad: { dir: scratchpadDir, author: 'main' } } : {}),
    readFileState,
    askUser,
  });

  const availablePool = assembleToolPool(deps.registry, toolContext);
  // 模型与执行器共用筛选后的池, 历史中的写工具名和 allow 规则不能重新扩入.
  const toolPool = input.permission.mode === 'plan'
    ? availablePool.filter(tool => PLAN_TOOL_IDS.has(tool.id))
    : availablePool;

  const toolResultStore = deps.toolResultStore?.(sessionId);
  // 子代理继承其它宿主能力, 但不能读取或结束根 Session 的目标.
  const { goalStore: _goalStore, ...subagentToolContext } = toolContext;
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
      ...(deps.toolExecutionState ? { toolExecutionState: deps.toolExecutionState } : {}),
      // 根 Tool 的终态要等 AgentLoop 把 ToolResult Message 落库后再广播
      // 进度与权限仍实时转发，tool_result 由 TurnExecutor.translate 唯一产出
      pushEv: event => {
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
    ...(narrativeSearch ? { narrativeSearch } : {}),
    createExecutor,
    createSubagentExecutor: ({ subagentId, runId, toolPool: subPool, signal, wake }) => {
      const executor = new StreamingToolExecutor({
        sessionId,
        turnId,
        subagentId,
        runId,
        abortSignal: signal,
        toolPool: subPool,
        permissionContext,
        askPermission,
        toolContext: subagentToolContext,
        toolResultStore,
        ...(deps.toolExecutionState ? { toolExecutionState: deps.toolExecutionState } : {}),
        // 子代理终态由 SubagentExecutor 在 ToolResult 写入 transcript 后发布;
        // 这里只实时转发执行进度和交互事件.
        pushEv: event => {
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
    abortSubagent: subagentId => deps.subagents.cancel(subagentId, sessionId),
    shutdown: async reason => {
      if (stopped) return;
      stopped = true;
      await currentExecutor?.shutdown(reason);
      await deps.subagents.abortForegroundForTurn(turnId);
    },
  };
}

/**
 * 队列条目在 cancel 时会以其默认终态 resolve（permission→deny、askUser→cancelled），
 * 因此这里只需在 abort 时撤销条目并等待同一个 Promise 收尾。
 */
async function awaitInteraction<T>(promise: Promise<T>, signal: AbortSignal, cancel: () => void): Promise<T> {
  if (signal.aborted) {
    cancel();
    return promise;
  }
  const onAbort = (): void => cancel();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await promise;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
