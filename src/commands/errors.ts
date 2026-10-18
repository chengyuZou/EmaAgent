export type CommandsErrorCode =
  | 'nothing_to_compact'
  | 'compact_below_threshold'
  | 'compact_failed'
  | 'provider/not_configured';

export class CommandsError extends Error {
  constructor(
    readonly code: CommandsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CommandsError';
  }
}
