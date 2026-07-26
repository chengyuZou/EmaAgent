// 定义根 Turn 执行器的准备结果、依赖端口与完整事件边界。

import type { SessionId, ToolCallId, TurnId } from '@ema-agent/ids';
import type {
  AskUserInteractionOutcome,
  KbAssetScope,
  RequestDegradationNotice,
  TurnEvent,
} from '@ema-agent/turn';
import type {
  AskUserRequiredEvent,
  ToolExecutionEvent,
} from '@ema-agent/tools';
import type {
  AgentRunEvent,
  AgentTurnEvent,
} from '@ema-agent/agent';
import type { KbSearchResult } from '@ema-agent/knowledge';
import type {
  LanguageModel,
  LlmContentPart,
  ThinkingMode,
} from '@ema-agent/llm';
import type {
  ContextContributionProvider,
  ContextEvent,
  ContextHistoryCompactor,
} from '@ema-agent/context';
import type { PromptSnapshot } from '@ema-agent/prompts';
import type { MessageBlocks, SessionStore, Turn } from '@ema-agent/session';
import type { HookBus, HookWarningEvent } from '@ema-agent/hooks';
import type { EmotionEngine, EmotionStreamEvent } from '@ema-agent/emotion';
import type {
  ToolExecutionJournalPort,
  ToolRegistry,
  ToolResultStore,
} from '@ema-agent/tools';
import type { SkillRunnerPort } from '@ema-agent/skills';
import type { CommandRunnerPort } from '@ema-agent/sandbox';
import type { IArtifactStore } from '@ema-agent/artifact';
import type {
  PermissionEngine,
  AskPermissionFn,
  PermissionStreamEvent,
} from '@ema-agent/permission';
import type { ModelCapabilityResolver } from '@ema-agent/provider';
import type { AgentRunStorePort } from '@ema-agent/agent';
import type { TaskStorePort } from '@ema-agent/tasks';

/** 根 Turn 等待 AskUser 回答所需的最小交互端口。 */
export interface AskUserInteractionPort {
  /** 使用调用方提供的 promptId，不在注册表中另建 UUID。 */
  createWithId(
    promptId: string,
    timeoutMs?: number,
    turnId?: string,
    request?: AskUserRequiredEvent,
  ): { promise: Promise<AskUserInteractionOutcome> };
  cancel(promptId: string): boolean;
}

// ── 运行依赖 ──────────────────────────────────────────────────────────────────

/**
 * TurnExecutor 所需依赖，是 AppBindings 的严格子集。
 * 依赖只描述根 Turn 执行，不包含 HTTP、SSE、TTS 或附件准备。
 *
 * 不包含 model_bindings：Provider 与模型解析属于 Orchestrator，
 * 执行器只通过 PreparedTurnExecution 接收已经确定的 providerId 和 model。
 */
export interface TurnExecutionDeps {
  session:    SessionStore;
  hooks:      HookBus;
  llm:        LanguageModel;
  modelCapabilities: ModelCapabilityResolver;
  emotion:    EmotionEngine;
  tools:      ToolRegistry;
  permission: PermissionEngine;
  /**
   * 按 Session 创建沙箱 Runner。无工作区或无执行能力时返回 undefined，
   * Bash 必须明确拒绝，不能回退到裸进程。
   * 每个 Session 的 workspaceRoot 不同，因此 Orchestrator 按 sessionId 缓存，
   * 不能使用全局单例；聚焦测试可以省略。
   */
  getCommandRunner?: (sessionId: SessionId) => CommandRunnerPort | undefined;
  /**
   * 为每个 Turn 创建连接到 SSE 事件流的 askPermission 回调。
   * 测试可省略，此时 PermissionEngine 使用构造参数中的 ask 配置，
   * 通常是默认拒绝的替身实现。
   */
  buildAsk?: (args: {
    sessionId: SessionId;
    turnId:    TurnId;
    toolCallId: ToolCallId;
    emit:      (ev: PermissionStreamEvent) => void;
  }) => AskPermissionFn;
  /**
   * 保存待回答 ask_user 请求的交互端口。执行器把解析函数注入 Tool Context，
   * ask_user 工具会等待该函数返回。
   */
  askUserInteraction?: AskUserInteractionPort;
  /** 持久 Artifact 存储，使 artifact_write/read/list 可以跨 Turn 使用。 */
  artifactStore?: IArtifactStore;
  /** Skill 运行桥接，使 skill_call 可以调用已注册 Skill。 */
  skillRunner?: SkillRunnerPort;
  /**
   * 知识库搜索能力，供 kb_search 工具执行 Agentic RAG。
   * kbIds 由模型工具调用提供；空数组或 undefined 表示使用当前激活知识库。
   * assetScopes 来自用户在聊天选择器中的文档范围，不由模型决定。
   * 只有工具未显式提供 kbIds 时，执行器才会传入 assetScopes。
   */
  kbSearch?: (query: string, topK?: number, kbIds?: string[], assetScopes?: KbAssetScope[], sessionId?: string, turnId?: string) => Promise<KbSearchResult>;
  /** 按 Session 获取大结果外置存储；测试与非 Agent 调用方可以省略。 */
  getSessionToolResultStore?: (sessionId: SessionId) => ToolResultStore;
  /**
   * 子 Agent 执行记录；根 Turn 不建立重复 AgentRun 投影。
   * 聚焦循环测试可以省略。
   */
  agentRunStore?: AgentRunStorePort;
  /** 根 Turn 的持久工作清单；子 Agent ToolContext 不继承该入口。 */
  taskStore?: TaskStorePort;
  /** 工具副作用的持久化状态机；生产环境由 Tools Journal 注入。 */
  toolExecutionJournal?: ToolExecutionJournalPort;
}

// ── Turn 执行输入 ─────────────────────────────────────────────────────────────

/**
 * 单次 Turn 的已准备输入。Provider 与模型等路由决策必须在调用
 * TurnExecutor.execute() 前完成，执行器不重新猜测控制面选择。
 */
export interface PreparedTurnExecution {
  /** 已经启动的 Turn；调用方负责先执行 session.startTurn。 */
  turn:                  Turn;
  /** session.startTurn 返回的取消信号，用户停止时触发。 */
  signal:                AbortSignal;
  /**
   * 用户消息内容。纯文本 Turn 使用字符串，多模态图片、音频和文件使用
   * LlmContentPart[]；执行器通过 Array.isArray 区分两种表示。
   */
  userInput:             string | LlmContentPart[];
  /** 只用于 Message 落库，禁止携带图片、音频或文件 Base64。 */
  persistedUserInput?:   MessageBlocks;
  /** Turn 开始时冻结的 Prompt Slot 快照，Agent 多轮共享同一 revision。 */
  prompt:                PromptSnapshot;
  /** 已解析的 provider_configs.id，由 Orchestrator 负责提供。 */
  providerId:            string;
  /** 已解析的模型名，由 Orchestrator 负责提供。 */
  model:                 string;
  /** 工作区根目录；空字符串表示不提供工作区。 */
  workspaceRoot: string;
  /** Core RuntimePaths 为当前 Turn 生成的临时目录；Agent 不负责拼接数据目录。 */
  scratchpadDir?: string;
  /** 用户在聊天选择器中选中的 KB ID；空数组或省略时使用当前激活知识库。 */
  kbIds?:         string[];
  /** 聊天选择器提供的逐 KB 文档范围；没有对应范围的 KB 不额外过滤。 */
  kbAssetScopes?: KbAssetScope[];
  /**
   * 每轮压缩回调，在 AgentLoop 调用模型前执行，防止多步骤 Work Turn
   * 在中途超过上下文窗口。Orchestrator 将其接到 ContextCompactor.compact()；
   * 测试和临时子 Agent 上下文可以省略。
   */
  prepareContextContributions?: ContextContributionProvider;
  compactContext?: ContextHistoryCompactor;
  /** 用户选择的思考模式，会传给 Agent 循环中的每次 LlmRequest。 */
  thinking?: ThinkingMode;
  /** Core 在执行器前完成的媒体降级。 */
  requestDegradations?: RequestDegradationNotice[];
}

/** 根 Turn 对外发出的完整事件集合；各成员仍由真实业务模块拥有。 */
export type TurnExecutionEvent =
  | TurnEvent
  | AgentTurnEvent
  | AgentRunEvent
  | ToolExecutionEvent
  | PermissionStreamEvent
  | EmotionStreamEvent
  | ContextEvent
  | HookWarningEvent;
