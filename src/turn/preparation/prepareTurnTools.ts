// 为一个根 Turn 冻结工具层：ToolPool、宿主能力上下文、权限判定上下文与两类交互口子。
import {
  SubagentSpawner,
  type AgentLoopEvent,
  type AgentBudget,
  type AgentRunMessagesStore,
  type AgentRunStore,
  type PrepareSubagent,
} from '@ema-agent/agent';
import type { KnowledgeSearch } from '@ema-agent/knowledge';
import type { CallVision } from '@ema-agent/vision';
import type { Message } from '@ema-agent/llm';
import type {
  NarrativeClient,
  NarrativeLlmConnection,
  NarrativeSearch,
} from '@ema-agent/narrative';
import {
  narrativeBridgeEnabledSetting,
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
  type StreamingToolExecutor as StreamingToolExecutorType,
  type ToolExecutionState,
  type ToolRegistry,
  type ToolResultStore,
  type ToolUseContext,
} from '@ema-agent/tools';
import { StreamingToolExecutor } from '@ema-agent/tools';
import type { ExecutionProfile, NarrativePolicy } from '@ema-agent/session';
import type { TurnKnowledgeSelection } from '../types.js';
import type { SessionInteractionQueue } from '../interactionQueue.js';
import type { TurnStreamEvent } from '../events.js';

/** Chat 只暴露只读检索工具；写文件、Shell、Task、子 Agent 与 Skill 属于 Work。 */
const CHAT_TOOL_IDS: ReadonlySet<string> = new Set([
  BuiltinTools.FileRead.id,
  BuiltinTools.Glob.id,
  BuiltinTools.Grep.id,
  BuiltinTools.WebFetch.id,
  BuiltinTools.WebSearch.id,
  BuiltinTools.KnowledgeBaseSearch.id,
  BuiltinTools.NarrativeSearch.id,
]);

export interface TurnToolsDeps {
  readonly registry: ToolRegistry;
  readonly interactionQueue: SessionInteractionQueue;
  readonly settings: SettingsStore;
  readonly agentRunStore: AgentRunStore;
  readonly agentRunMessagesStore: AgentRunMessagesStore;
  readonly taskStore?: TaskStore;
  readonly knowledgeSearch?: KnowledgeSearch;
  /** narrativePolicy 非 'off' 时构建本 Turn 召回闭包；与 resolveNarrativeLlm 同时缺失则无 Narrative 能力。 */
  readonly narrativeClient?: NarrativeClient;
  /** Turn 开始时解析一次当次 Narrative LLM 连接并冻结进闭包；未绑定或协议不支持返回 undefined。 */
  readonly resolveNarrativeLlm?: () => NarrativeLlmConnection | undefined;
  readonly backgroundProcesses?: BackgroundProcess;
  /** 每 Turn 解析一次 vision 调用闭包；无绑定时返回 undefined（PDF 只读文本层）。 */
  readonly resolveVision?: () => CallVision | undefined;
  readonly commandRunner?: (sessionId: string) => CommandRunner | undefined;
  readonly toolResultStore?: (sessionId: string) => ToolResultStore;
  readonly toolExecutionState?: ToolExecutionState;
}

export interface PrepareTurnToolsInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly executionProfile: ExecutionProfile;
  readonly narrativePolicy: NarrativePolicy;
  readonly workspaceRoot: string;
  readonly scratchpadDir?: string;
  readonly skillPool?: SkillPool;
  /** 本 Turn 在当前激活知识库内冻结的文档范围。 */
  readonly knowledge?: TurnKnowledgeSelection;
  readonly budget: AgentBudget;
  readonly prepareSubagent: PrepareSubagent;
  /** fork 子 Agent 继承用的父工作消息；不含 System Prompt、Tool Schema 或缓存标记。 */
  readonly parentMessages: Message[];
  readonly model: { readonly providerId: string; readonly modelId: string };
  /** 事件出口由 turn.ts 绑定到本 Turn 的事件通道（每 Turn 一个）。 */
  readonly emit: (event: TurnStreamEvent) => void;
  /** 子 Agent 的物理调用不经过根 AgentLoop，由 Turn 注入同一本账的终态出口。 */
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
    readonly isBypassPermissionsModeAvailable: boolean;
  };
  readonly signal: AbortSignal;
}

export interface TurnToolsAssembly {
  readonly toolPool: ToolPool;
  readonly toolContext: ToolUseContext;
  readonly permissionContext: ToolPermissionContext;
  readonly spawner: SubagentSpawner;
  /** 本 Turn 冻结的召回闭包：auto 时进 Tool Context，always 时供 reminder；off 或无能力为 undefined。 */
  readonly narrativeSearch?: NarrativeSearch;
  readonly createExecutor: (wake: () => void) => StreamingToolExecutorType;
  /** 子 Agent 执行器：收窄后的独立 ToolPool、关联 agentRunId、无 askPermission（headless）。 */
  readonly createSubagentExecutor: (args: {
    agentRunId: string;
    toolPool: ToolPool;
    signal: AbortSignal;
    wake: () => void;
  }) => StreamingToolExecutorType;
  readonly abortTool: (toolCallId: string) => boolean;
  readonly abortAgentRun: (agentRunId: string) => boolean;
  /** 根 Turn 终态前调用：先停工具再停子 Agent；幂等。 */
  readonly shutdown: (reason: string) => Promise<void>;
}

export function prepareTurnTools(
  deps: TurnToolsDeps,
  input: PrepareTurnToolsInput,
): TurnToolsAssembly {
  const { sessionId, turnId, workspaceRoot, scratchpadDir } = input;
  const readFileState: ReadFileState = new Map();

  const spawner = new SubagentSpawner({
    parentSessionId: sessionId,
    parentTurnId: turnId,
    providerId: input.model.providerId,
    defaultModelId: input.model.modelId,
    budget: input.budget,
    prepareSubagent: input.prepareSubagent,
    agentRunStore: deps.agentRunStore,
    messagesStore: deps.agentRunMessagesStore,
    // agent 包事件不携带根身份；进入 Turn 事件流时补上。
    emit: event => input.emit({ ...event, sessionId, turnId }),
    ...(input.onSubagentLlmCallFinished
      ? { onLlmCallFinished: input.onSubagentLlmCallFinished }
      : {}),
  });

  const permissionContext: ToolPermissionContext = {
    mode: input.permission.mode,
    alwaysAllowRules: input.permission.buckets.alwaysAllowRules,
    alwaysDenyRules: input.permission.buckets.alwaysDenyRules,
    alwaysAskRules: input.permission.buckets.alwaysAskRules,
    isBypassPermissionsModeAvailable: input.permission.isBypassPermissionsModeAvailable,
    ...(workspaceRoot ? { workspaceRoot } : {}),
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
    // 取消/超时也要发空答案清前端卡片；空答案 resolved 是清卡信号，不是成功。
    input.emit({
      type: 'ask_user_resolved',
      sessionId,
      toolCallId,
      answers: outcome.status === 'answered' ? { ...outcome.answers } : {},
    });
    if (outcome.status === 'answered') return { answers: { ...outcome.answers } };
    throw new Error(`AskUser ${outcome.status}: ${outcome.reason}`);
  };

  const commandRunner = deps.commandRunner?.(sessionId);
  const vision = deps.resolveVision?.();
  // 召回闭包在本 Turn 构建一次：LLM 连接、模式覆盖与进程开关全部冻结；
  // auto 时模型经 Tool 触发，always 时 reminder 触发，二者共用同一实现。
  const narrativeSearch = ((): NarrativeSearch | undefined => {
    if (input.narrativePolicy === 'off') return undefined;
    if (!deps.narrativeClient || !deps.resolveNarrativeLlm) return undefined;
    if (!deps.settings.get(narrativeBridgeEnabledSetting)) return undefined;
    const llm = deps.resolveNarrativeLlm();
    if (!llm) return undefined;
    const client = deps.narrativeClient;
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
    workspaceRoot,
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
    subagentSpawner: spawner,
    ...(input.skillPool ? { skillPool: input.skillPool } : {}),
    ...(scratchpadDir
      ? { scratchpad: { dir: scratchpadDir, author: 'main' } }
      : {}),
    readFileState,
    askUser,
  });

  const assembled = assembleToolPool(deps.registry, toolContext);
  const toolPool = input.executionProfile === 'chat'
    ? assembled.filter(tool => CHAT_TOOL_IDS.has(tool.id))
    : assembled;

  const toolResultStore = deps.toolResultStore?.(sessionId);
  let currentExecutor: StreamingToolExecutorType | undefined;
  const createExecutor = (wake: () => void): StreamingToolExecutorType => {
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
      pushEv: event => input.emit(event),
      wake,
    });
    currentExecutor = executor;
    return executor;
  };

  let stopped = false;
  return {
    toolPool,
    toolContext,
    permissionContext,
    spawner,
    ...(narrativeSearch ? { narrativeSearch } : {}),
    createExecutor,
    createSubagentExecutor: ({ agentRunId, toolPool: subPool, signal, wake }) => {
      const executor = new StreamingToolExecutor({
        sessionId,
        turnId,
        agentRunId,
        abortSignal: signal,
        toolPool: subPool,
        permissionContext,
        // 子 Agent 无 askPermission：headless，中央把 ask 收口为 deny。
        toolContext,
        toolResultStore,
        ...(deps.toolExecutionState
          ? { toolExecutionState: deps.toolExecutionState }
          : {}),
        pushEv: event => input.emit(event),
        wake,
      });
      return executor;
    },
    abortTool: toolCallId => currentExecutor?.abortTool(toolCallId) ?? false,
    abortAgentRun: agentRunId => spawner.abortSubagent(agentRunId),
    shutdown: async reason => {
      if (stopped) return;
      stopped = true;
      await currentExecutor?.shutdown(reason);
      await spawner.shutdown(reason);
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
