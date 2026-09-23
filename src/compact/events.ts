interface CompactEventBase {
  readonly compactId: string;
  readonly sessionId: string;
  readonly beforeTokens: number;
  readonly startedAt: number;
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
