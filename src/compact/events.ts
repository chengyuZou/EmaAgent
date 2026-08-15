// 定义历史压缩过程向当前 Turn 公开的业务事件。
interface CompactEventBase {
  readonly compactId: string;
  readonly sessionId: string;
  readonly turnId: string;
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
