// Commands 用例错误：HTTP 边界按 code 映射状态码。
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
