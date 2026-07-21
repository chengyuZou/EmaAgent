export type PromptAssemblyErrorCode =
  | 'prompt/duplicate-slot'
  | 'prompt/invalid-slot';

export class PromptAssemblyError extends Error {
  constructor(
    readonly code: PromptAssemblyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PromptAssemblyError';
  }
}
