export type ContextAssemblyErrorCode =
  | 'context/empty-system-prompt'
  | 'context/invalid-current-date'
  | 'context/system-message-outside-prompt';

export class ContextAssemblyError extends Error {
  constructor(
    readonly code: ContextAssemblyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ContextAssemblyError';
  }
}
