import type { TurnMode, MessageId, MessageRole, AssistantBlock, LlmMessage } from '@ema-agent/contracts';

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

// ── 各事件 payload 结构 ──────────────────────────────────────────────────

export interface HookPayload {
  beforeLlm: {
    /**
     * system prompt 文本的便捷副本,供需要读取它的 hook 使用,无需从 `messages` 里翻找。
     * 由 wiring.ts 注册的 `prompts:buildSystem` hook 填充。
     *
     * engine(conversation-flow)只消费 `messages` - 不读此字段。
     * 想替换 system prompt 的 hook 应同时更新此字段和 messages[0],保持同步。
     */
    systemPrompt: string;
    messages: LlmMessage[];
  };
  afterLlmComplete: {
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
   * 工具执行前立即触发 - 仅用于 UI 和审计。
   *
   * 工具权限决策(allow / ask / deny)由 PermissionEngine 在本 hook 触发前做出。
   * 沙箱执行边界由 CommandRunner 强制。本 hook 无法拦截、修改或取消工具执行。
   * 用它更新 UI(显示"正在运行工具…")或记录审计日志。
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
    messageCount: number;
    tokenEstimate: number;
  };
  afterCompact: {
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
