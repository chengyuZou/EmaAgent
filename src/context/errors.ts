export type ContextAssemblyErrorCode =
  | 'context/prompt-boundary-missing'
  | 'context/prompt-boundary-duplicated'
  | 'context/empty-static-prompt'
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
