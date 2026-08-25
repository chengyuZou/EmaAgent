// 定义历史压缩过程公开的业务事件。Session 域事件：不携带 Turn 身份——
// 自动压缩由 Turn 包一层投影为 TurnEvent，手动压缩由 Command 自己的出口返回。
interface CompactEventBase {
  readonly compactId: string;
  readonly sessionId: string;
  readonly beforeTokens: number;
}

export type CompactEvent =
  | ({ readonly type: 'compact_started' } & CompactEventBase)
  | ({
      readonly type: 'compact_history_truncated';
      /**
       * 历史超过触发线（窗口 × (1 - bufferRatio)，默认 85%）时最旧前缀被直接
       * 淘汰（未进入摘要）的总消息条数与估算 token：含一刀切与候选收缩两段。
       */
      readonly droppedMessageCount: number;
      readonly droppedTokens: number;
    } & CompactEventBase)
  | ({
      readonly type: 'compact_cancelled';
      readonly durationMs: number;
    } & CompactEventBase)
  | ({
      readonly type: 'compact_completed';
      readonly afterTokens: number;
      readonly savedTokens: number;
      readonly durationMs: number;
    } & CompactEventBase)
  | ({
      readonly type: 'compact_failed';
      readonly error: string;
      readonly afterTokens: number;
      readonly durationMs: number;
    } & CompactEventBase);
