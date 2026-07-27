// 定义根 Turn 执行器的准备结果、依赖端口与完整事件边界。

import type { SessionId, TurnId } from '@ema-agent/ids';
import type {
  ExecutionProfile,
  KbAssetScope,
  NarrativePolicy,
  RequestDegradationNotice,
  TurnEvent,
  TurnFailureCode,
  TurnStats,
  TurnTriggerType,
} from '@ema-agent/turn';
import type { ToolExecutionEvent } from '@ema-agent/tools';
import type {
  AgentRunEvent,
  AgentTurnEvent,
} from '@ema-agent/agent';
import type {
  LlmContentPart,
  ThinkingMode,
} from '@ema-agent/llm';
import type { ContextEvent } from '@ema-agent/context';
import type { MemoryRecallEvent } from '@ema-agent/memory';
import type { PromptSnapshot } from '@ema-agent/prompts';
import type { MessageBlocks, SessionStore, Turn } from '@ema-agent/session';
import type { HookBus, HookWarningEvent } from '@ema-agent/hooks';
import type { EmotionStreamEvent } from '@ema-agent/emotion';
import type { PermissionStreamEvent } from '@ema-agent/permission';
import type { ModelCapabilitySnapshot } from '@ema-agent/provider';
import type { NarrativeEvent } from '@ema-agent/narrative';

// ── 运行依赖 ──────────────────────────────────────────────────────────────────

/** 根 Turn 终态清理统一交互队列所需的最小生命周期端口。 */
export interface TurnInteractionCleanup {
  cancelForTurn(turnId: TurnId, reason: string): number;
}

/**
 * TurnExecutor 所需依赖，是 AppBindings 的严格子集。
 * 依赖只描述根 Turn 执行，不包含 HTTP、SSE、TTS 或附件准备。
 *
 * 不包含 model_bindings：Provider 与模型解析属于输入准备阶段，
 * 执行器只消费已经确定的 providerId 和 model。
 */
export interface TurnExecutionDeps {
  session: SessionStore;
  hooks: HookBus;
  interactions: TurnInteractionCleanup;
}

// ── Turn 启动与执行输入 ───────────────────────────────────────────────────────

/** 一次根 Turn 冻结的模型选择与能力，整个 Agent 循环只能读取这一份。 */
export interface TurnModelSnapshot {
  readonly providerId: string;
  readonly model: string;
  readonly capabilities: ModelCapabilitySnapshot;
}

/** Turn 创建后冻结的纯值输入，不携带回调、存储对象或运行时服务。 */
export interface TurnInput {
  /**
   * 用户消息内容。纯文本 Turn 使用字符串，多模态图片、音频和文件使用
   * LlmContentPart[]；执行器通过 Array.isArray 区分两种表示。
   */
  readonly userInput:             string | readonly LlmContentPart[];
  /** 只用于 Message 落库，禁止携带图片、音频或文件 Base64。 */
  readonly persistedUserInput:    MessageBlocks;
  /** Turn 开始时冻结的 Prompt Slot 快照，Agent 多轮共享同一 revision。 */
  readonly prompt:                PromptSnapshot;
  /** 已解析且冻结的模型身份、能力与窗口预算。 */
  readonly model:                 TurnModelSnapshot;
  /** 工作区根目录；空字符串表示不提供工作区。 */
  readonly workspaceRoot: string;
  /** 进程宿主为当前 Turn 生成的临时目录；Agent 不负责拼接数据目录。 */
  readonly scratchpadDir?: string;
  /** 用户在聊天选择器中选中的 KB ID；空数组或省略时使用当前激活知识库。 */
  readonly kbIds?:         readonly string[];
  /** 聊天选择器提供的逐 KB 文档范围；没有对应范围的 KB 不额外过滤。 */
  readonly kbAssetScopes?: readonly KbAssetScope[];
  /** 用户选择的思考模式，会传给 Agent 循环中的每次 LlmRequest。 */
  readonly thinking?: ThinkingMode;
  /** 输入准备阶段完成的媒体降级。 */
  readonly requestDegradations: readonly RequestDegradationNotice[];
}

/** 输入准备阶段只暴露本轮稳定身份和同一条取消信号。 */
export interface TurnPreparationContext {
  readonly turn: Turn;
  readonly signal: AbortSignal;
}

/**
 * 创建根 Turn 的完整命令。`userInput` 是需要写入 Turn 行的原始文本；
 * 多模态模型输入由 prepare 使用同一 Turn 身份生成。
 */
export interface TurnStartCommand {
  readonly sessionId: SessionId;
  readonly triggerType: TurnTriggerType;
  readonly executionProfile: ExecutionProfile;
  readonly narrativePolicy: NarrativePolicy;
  readonly userInput: string;
  readonly prepare: (
    context: TurnPreparationContext,
  ) => TurnInput | Promise<TurnInput>;
}

/** Turn 对外只有一个明确终态，完成 Promise 与终态事件使用同一份数据。 */
export type TurnOutcome =
  | {
      readonly status: 'completed';
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly stats: TurnStats;
    }
  | {
      readonly status: 'failed';
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly code: TurnFailureCode;
      readonly message: string;
    }
  | {
      readonly status: 'aborted';
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly reason: string;
    };

/**
 * 根 Turn 的稳定运行句柄。事件流只允许一个消费者；重复消费会明确失败，
 * 避免两个调用方竞争同一组增量事件。
 */
export interface TurnHandle {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly events: AsyncIterable<TurnExecutionEvent>;
  readonly completion: Promise<TurnOutcome>;
  abort(): void;
}

/** 根 Turn 对外发出的完整事件集合；各成员仍由真实业务模块拥有。 */
export type TurnExecutionEvent =
  | TurnEvent
  | AgentTurnEvent
  | AgentRunEvent
  | ToolExecutionEvent
  | PermissionStreamEvent
  | EmotionStreamEvent
  | NarrativeEvent
  | MemoryRecallEvent
  | ContextEvent
  | HookWarningEvent;
