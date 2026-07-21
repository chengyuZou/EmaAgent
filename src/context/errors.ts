export type ContextAssemblyErrorCode =
  | 'context/empty-contribution-id'
  | 'context/duplicate-contribution-id';

export class ContextAssemblyError extends Error {
  constructor(
    readonly code: ContextAssemblyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ContextAssemblyError';
  }
}
