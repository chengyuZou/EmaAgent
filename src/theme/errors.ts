export class InvalidThemeValueError extends Error {
  readonly code = 'theme/invalid-value';

  constructor(readonly field: string, readonly value: unknown) {
    super(`Invalid theme value for ${field}`);
    this.name = 'InvalidThemeValueError';
  }
}
