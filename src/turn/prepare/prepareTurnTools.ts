// 为一次 Turn 冻结工具层: ToolPool 宿主能力上下文 权限判定上下文与两类交互口子
import type {
  SubagentExecutor,
  AgentLoopEvent,
  PrepareSubagent,
} from '@ema-agent/agent';
import type { KnowledgeSearch } from '@ema-agent/knowledge';
import type { CallVision } from '@ema-agent/vision';
import type {
  NarrativeClient,
  NarrativeLlmConnection,
  NarrativeSearch,
} from '@ema-agent/narrative';
import {
  narrativeQueryModeSetting,
  prepareNarrativeRecall,
} from '@ema-agent/narrative';
import {
  applyPermissionUpdate,
  type PermissionMode,
  type PermissionRequest,
  type PermissionResponse,
  type ToolPermissionContext,
} from '@ema-agent/permission';
import type { CommandRunner } from '@ema-agent/sandbox';
import type { SettingsStore } from '@ema-agent/settings';
import type { SkillPool } from '@ema-agent/skills';
import type { TaskStore } from '@ema-agent/tasks';
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
  type ToolRegistry,
  type ToolResultStore,
  type ToolUseContext,
} from '@ema-agent/tools';
import type { SessionMode, NarrativePolicy } from '@ema-agent/session';
import type { TurnKnowledgeSelection } from '../types.js';
import type { SessionInteractionQueue } from '../interactionQueue.js';
import type { TurnStreamEvent } from '../events.js';

export interface TurnToolsDeps {
  readonly registry: ToolRegistry;
  readonly interactionQueue: SessionInteractionQueue;
  readonly settings: SettingsStore;
  readonly subagents: SubagentExecutor;
  readonly taskStore?: TaskStore;
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
  /** 子 Agent 执行器: 收窄后的独立 ToolPool 关联 subagentId 无 askPermission */
  readonly createSubagentExecutor: (args: {
    subagentId: string;
    toolPool: ToolPool;
    signal: AbortSignal;
    wake: () => void;
  }) => StreamingToolExecutor;
  readonly abortTool: (toolCallId: string) => boolean;
  readonly abortSubagent: (subagentId: string) => boolean;
  /** 根 Turn 终态前调用：先停工具再停子 Agent；幂等。 */
  readonly shutdown: (reason: string) => Promise<void>;
}

export function prepareTurnTools(
  deps: TurnToolsDeps,
  input: PrepareTurnToolsInput,
): TurnToolsAssembly {
  const { sessionId, turnId, cwd, scratchpadDir } = input;
  const readFileState: ReadFileState = new Map();

  const permissionContext: ToolPermissionContext = {
    mode: input.permission.mode,
    alwaysAllowRules: input.permission.buckets.alwaysAllowRules,
    alwaysDenyRules: input.permission.buckets.alwaysDenyRules,
    alwaysAskRules: input.permission.buckets.alwaysAskRules,
    workspaceRoots: input.workspaceRoots,
  };

  // 根 Turn 始终 interactive：ask 决策经队列等用户；子 Agent 的装配（prepareSubagent）
  // 不提供此口子，中央自动收口 deny(headless)。
  const askPermission = async (
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<PermissionResponse> => {
    input.emit({ type: 'permission_required', ...request });
    const { promise } = deps.interactionQueue.enqueuePermission(request);
    const response = await awaitInteraction(promise, signal, () => {
      deps.interactionQueue.cancel(request.toolCallId, 'turn aborted');
    });
    input.emit({
      type: 'permission_resolved',
      sessionId,
      turnId,
      toolCallId: request.toolCallId,
      decision: response.action === 'deny' ? 'deny' : 'allow',
    });
    if (response.action === 'allowSession' && request.ruleSuggestion) {
      applyPermissionUpdate(deps.settings, {
        type: 'addRules',
        destination: 'session',
        rules: [request.ruleSuggestion],
        behavior: 'allow',
      }, { sessionId });
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
    input.emit(request);
    const { promise } = deps.interactionQueue.enqueueAskUser(request);
    const outcome = await awaitInteraction(promise, signal, () => {
      deps.interactionQueue.cancel(toolCallId, 'turn aborted');
    });
    // 取消/超时也要发空答案清前端卡片: 空答案 resolved 是清卡信号, 不是成功
    input.emit({
      type: 'ask_user_resolved',
      sessionId,
      toolCallId,
      answers: outcome.status === 'answered' ? { ...outcome.answers } : {},
    });
    if (outcome.status === 'answered') return { answers: { ...outcome.answers } };
    throw new Error(`AskUser ${outcome.status}: ${outcome.reason}`);
  };

  const commandRunner = deps.commandRunner?.(cwd, input.workspaceRoots);
  const vision = deps.resolveVision?.();
  // 召回闭包在本 Turn 构建一次: LLM 连接与模式覆盖全部冻结;
  // auto 时模型经 Tool 触发, always 时 reminder 触发, 二者共用同一实现
  const narrativeSearch = ((): NarrativeSearch | undefined => {
    if (input.narrativePolicy === 'off') return undefined;
    if (!deps.currentNarrativeClient || !deps.resolveNarrativeLlm) return undefined;
    const client = deps.currentNarrativeClient();
    if (!client) return undefined;
    const llm = deps.resolveNarrativeLlm();
    if (!llm) return undefined;
    const queryModeOverride = deps.settings.get(narrativeQueryModeSetting);
    return (query, mode, signal) =>
      prepareNarrativeRecall(client, {
        sessionId,
        turnId,
        userInput: query,
        llm,
        mode: queryModeOverride !== 'auto' ? queryModeOverride : (mode ?? 'hybrid'),
        signal,
        emit: event => input.emit(event),
      });
  })();
  const toolContext: ToolUseContext = Object.freeze({
    cwd,
    platform: process.platform,
    ...(commandRunner ? { commandRunner } : {}),
    ...(vision ? { vision } : {}),
    ...(deps.backgroundProcesses
      ? { backgroundProcesses: deps.backgroundProcesses }
      : {}),
    ...(deps.knowledgeSearch
      ? {
          knowledgeSearch: ((request) => deps.knowledgeSearch!({
            ...request,
            // Tool 显式给出 assetIds 时优先；否则继承本 Turn 冻结的文档范围。
            ...(request.assetIds === undefined && input.knowledge?.assetIds?.length
              ? { assetIds: [...input.knowledge.assetIds] }
              : {}),
          })) as KnowledgeSearch,
        }
      : {}),
    ...(input.narrativePolicy === 'auto' && narrativeSearch
      ? { narrativeSearch }
      : {}),
    ...(deps.taskStore ? { taskStore: deps.taskStore } : {}),
    subagents: {
      start: (prompt, options, toolCallId, runInBackground, signal) => deps.subagents.start({
        sessionId,
        parentTurnId: turnId,
        toolCallId,
        prompt,
        options: {
          ...options,
          providerId: options.providerId ?? input.providerId,
          modelId: options.modelId ?? input.modelId,
        },
        prepareSubagent: input.prepareSubagent,
        parentSignal: signal,
        runInBackground,
        ...(input.onSubagentLlmCallFinished
          ? { onLlmCallFinished: input.onSubagentLlmCallFinished }
          : {}),
      }),
      waitForInitialResult: (subagentId, signal) =>
        deps.subagents.waitForInitialResult(subagentId, sessionId, signal),
      moveToBackground: subagentId => deps.subagents.moveToBackground(subagentId, sessionId),
      awaitResult: (subagentId, signal) => deps.subagents.awaitResult(subagentId, sessionId, signal),
      cancel: subagentId => deps.subagents.cancel(subagentId, sessionId),
    },
    ...(input.skillPool ? { skillPool: input.skillPool } : {}),
    ...(scratchpadDir
      ? { scratchpad: { dir: scratchpadDir, author: 'main' } }
      : {}),
    readFileState,
    askUser,
  });

  const toolPool = assembleToolPool(deps.registry, toolContext);
  
  const toolResultStore = deps.toolResultStore?.(sessionId);
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
      ...(deps.toolExecutionState
        ? { toolExecutionState: deps.toolExecutionState }
        : {}),
      // 根 Tool 的终态要等 AgentLoop 把 ToolResult Message 落库后再广播
      // 进度与权限仍实时转发，tool_result 由 TurnExecutor.translate 唯一产出
      pushEv: event => {
        if (event.type !== 'tool_result') input.emit(event);
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
    createSubagentExecutor: ({ subagentId, toolPool: subPool, signal, wake }) => {
      const executor = new StreamingToolExecutor({
        sessionId,
        turnId,
        subagentId,
        abortSignal: signal,
        toolPool: subPool,
        permissionContext,
        // 子 Agent 无 askPermission: headless, 中央把 ask 收口为 deny
        toolContext,
        toolResultStore,
        ...(deps.toolExecutionState
          ? { toolExecutionState: deps.toolExecutionState }
          : {}),
        // 子代理终态由 SubagentExecutor 在 ToolResult 写入 transcript 后发布;
        // 这里只实时转发执行进度和交互事件.
        pushEv: event => {
          if (event.type !== 'tool_result') input.emit(event);
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
async function awaitInteraction<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  cancel: () => void,
): Promise<T> {
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
