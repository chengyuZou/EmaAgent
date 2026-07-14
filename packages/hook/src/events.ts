import type {
  AssistantBlock,
  CompactionId,
  LlmCallId,
  LlmMessage,
  MessageId,
  MessageRole,
  NarrativeTimelineRecall,
  TurnMode,
} from '@ema-agent/contracts';

/**
 * 所有 hook 事件都是 turn 级别的 engine 内部生命周期事件。
 *
 * CLAUDE.md 规范中的两个事件在此刻意省略:
 *   - onCharacterCardSwitch  -> 直接作为 `character_card_switched` EmaStreamEvent 发出
 *   - onEmotionChange        -> 直接作为 `emotion_changed` EmaStreamEvent 发出
 * 这两个是 app 级通知,无需 hook 拦截或优先级排序,因此完全绕过 HookBus。
 */
export type HookEvent =
  | 'beforeLlm'
  | 'afterLlmComplete'
  | 'afterMessage'
  | 'beforeToolUse'
  | 'afterToolUse'
  | 'onToolFailure'
  | 'beforeCompact'
  | 'afterCompact'
  | 'onTurnStart'
  | 'onTurnEnd'
  | 'onTurnAbort';

/**
 * 允许 handler 改变控制流的事件。
 *
 * 工具生命周期事件刻意不在此列：工具安全由 PermissionEngine 与 Sandbox
 * 负责，Hook 只承担观察、审计和 UI 扩展职责。
 */
export type ControlHookEvent =
  | 'beforeLlm'
  | 'beforeCompact'
  | 'onTurnStart';

/** 只能决定是否继续、不能替换 Payload 的控制事件。 */
export type AbortOnlyHookEvent = 'beforeCompact';

export type ObserverHookEvent = Exclude<HookEvent, ControlHookEvent>;

// ── 各事件 payload 结构 ──────────────────────────────────────────────────

export interface HookPayload {
  beforeLlm: {
    /** 当前 Turn 内的逻辑推理轮次；单轮 Conversation 固定为 1。 */
    iteration: number;
    /** 逻辑 LLM 调用 ID；Provider 内部重试必须保持同一个 ID。 */
    llmCallId: LlmCallId;
    /** LLM 请求的唯一消息事实来源；system prompt 必须是其中的 system message。 */
    messages: LlmMessage[];
    /** 当前 Turn 的业务模式。 */
    mode: TurnMode;
    /** 当前用户输入的可读文本；多模态输入只提取 text part。 */
    userInput: string;
    /** 本次调用已经解析完成的 Provider 实例 ID。 */
    providerId: string;
    /** 本次调用已经解析完成的模型名。 */
    model: string;
    /** Agent workspace；普通对话没有 workspace。 */
    workspaceRoot?: string | null;
    /** Narrative Hook 产生的正式流水线结果，供 Engine 落盘和前端展示。 */
    narrativeRecall?: {
      timelines: NarrativeTimelineRecall[];
    };
  };
  afterLlmComplete: {
    /** 与对应 beforeLlm 完全相同的逻辑推理轮次。 */
    iteration: number;
    /** 与对应 beforeLlm 完全相同的逻辑 LLM 调用 ID。 */
    llmCallId: LlmCallId;
    content: string;
    /** 本次 LLM 响应产出的 tool-use 块,按 block 顺序。 */
    toolCalls?: Array<Extract<AssistantBlock, { type: 'tool_use' }>>;
  };
  afterMessage: {
    messageId: MessageId;
    role: MessageRole;
    content: string;
  };
  /**
   * PermissionEngine 决策前观察模型的工具意图 - 仅用于 UI 和审计。
   *
   * 顺序固定为 beforeToolUse -> PermissionEngine -> Sandbox。
   * Hook 只能观察意图，不能授权、拒绝、改参或绕过沙箱；权限决策
   * (allow / ask / deny)仍只由 PermissionEngine 作出。
   * 沙箱执行边界由 CommandRunner 强制。本 hook 无法拦截、修改或取消工具执行。
   * 用它更新 UI(显示"准备调用工具…")或记录审计日志。
   */
  beforeToolUse: {
    callId: string;
    name: string;
    args: unknown;
  };
  afterToolUse: {
    callId: string;
    name: string;
    output: unknown;
  };
  onToolFailure: {
    callId: string;
    name: string;
    error: unknown;
  };
  beforeCompact: {
    compactionId: CompactionId;
    messageCount: number;
    tokenEstimate: number;
  };
  afterCompact: {
    compactionId: CompactionId;
    before: number;
    after: number;
    method: string;
  };
  onTurnStart: {
    mode: TurnMode;
  };
  onTurnEnd: {
    durationMs: number;
  };
  onTurnAbort: {
    reason: string;
  };
}
