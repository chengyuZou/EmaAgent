// 为一个根 Turn 冻结工具层：ToolPool、宿主能力上下文、权限判定上下文与两类交互口子。
import {
  SubagentSpawner,
  type AgentBudget,
  type AgentRunMessagesStore,
  type AgentRunStore,
  type PrepareSubagent,
} from '@ema-agent/agent';
import type { KnowledgeSearch } from '@ema-agent/knowledge';
import type { Message } from '@ema-agent/llm';
import type { NarrativeSearch } from '@ema-agent/narrative';
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
import type {
  ExecutionProfile,
  NarrativePolicy,
} from '@ema-agent/turn-terms';
import type {
  SessionInteractionQueue,
} from '../interaction/sessionInteractionQueue.js';
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

type DecisionQueue = SessionInteractionQueue<
  PermissionRequest,
  PermissionResponse,
  AskUserRequiredEvent
>;

export interface TurnToolsDeps {
  readonly registry: ToolRegistry;
  readonly decisionQueue: DecisionQueue;
  readonly settings: SettingsStore;
  readonly agentRunStore: AgentRunStore;
  readonly agentRunMessagesStore: AgentRunMessagesStore;
  readonly taskStore?: TaskStore;
  readonly knowledgeSearch?: KnowledgeSearch;
  /** narrativePolicy = 'auto' 时宿主注入的剧情检索入口；'always'/'off' 不装配。 */
  readonly narrativeSearch?: NarrativeSearch;
  readonly backgroundProcesses?: BackgroundProcess;
  readonly commandRunner?: (sessionId: string) => CommandRunner | undefined;
  readonly toolResultStore?: (sessionId: string) => ToolResultStore;
  readonly toolExecutionState?: ToolExecutionState;
  /** 事件出口由 turn.ts 绑定到本 Turn 的事件通道。 */
  readonly emit: (event: TurnStreamEvent) => void;
}

export interface PrepareTurnToolsInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly executionProfile: ExecutionProfile;
  readonly narrativePolicy: NarrativePolicy;
  readonly workspaceRoot: string;
  readonly scratchpadDir?: string;
  readonly skillPool?: SkillPool;
  /** 本 Turn 冻结的 KB 文档范围；Tool 显式 assetIds 时才被覆盖。 */
  readonly kbAssetIds?: readonly string[];
  readonly budget: AgentBudget;
  readonly prepareSubagent: PrepareSubagent;
  /** fork 子 Agent 继承用的最终请求视图；turn.ts 持有并在每次请求后 splice 更新。 */
  readonly parentMessages: Message[];
  readonly model: { readonly providerId: string; readonly modelId: string };
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
  readonly createExecutor: (wake: () => void) => StreamingToolExecutorType;
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
    emit: event => deps.emit(event),
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
    deps.emit({ type: 'permission_required', ...request });
    const { promise } = deps.decisionQueue.enqueuePermission({
      sessionId,
      turnId,
      toolCallId: request.toolCallId,
      prompt: request,
    });
    const response = await awaitInteraction(promise, signal, () => {
      deps.decisionQueue.cancel(request.toolCallId, 'turn aborted');
    });
    deps.emit({
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
    deps.emit(request);
    const { promise } = deps.decisionQueue.enqueueAskUser({
      toolCallId,
      sessionId,
      turnId,
      request,
    });
    const outcome = await awaitInteraction(promise, signal, () => {
      deps.decisionQueue.cancel(toolCallId, 'turn aborted');
    });
    // 取消/超时也要发空答案清前端卡片；空答案 resolved 是清卡信号，不是成功。
    deps.emit({
      type: 'ask_user_resolved',
      sessionId,
      toolCallId,
      answers: outcome.status === 'answered' ? { ...outcome.answers } : {},
    });
    if (outcome.status === 'answered') return { answers: { ...outcome.answers } };
    throw new Error(`AskUser ${outcome.status}: ${outcome.reason}`);
  };

  const commandRunner = deps.commandRunner?.(sessionId);
  const toolContext: ToolUseContext = Object.freeze({
    workspaceRoot,
    platform: process.platform,
    ...(commandRunner ? { commandRunner } : {}),
    ...(deps.backgroundProcesses
      ? { backgroundProcesses: deps.backgroundProcesses }
      : {}),
    ...(deps.knowledgeSearch
      ? {
          knowledgeSearch: ((request) => deps.knowledgeSearch!({
            ...request,
            // Tool 显式给出 assetIds 时优先；否则继承本 Turn 冻结的文档范围。
            ...(request.assetIds === undefined && input.kbAssetIds?.length
              ? { assetIds: [...input.kbAssetIds] }
              : {}),
          })) as KnowledgeSearch,
        }
      : {}),
    ...(input.narrativePolicy === 'auto' && deps.narrativeSearch
      ? { narrativeSearch: deps.narrativeSearch }
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
      pushEv: event => deps.emit(event),
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
    createExecutor,
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
