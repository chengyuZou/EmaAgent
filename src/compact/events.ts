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
