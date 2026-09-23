export class AttachmentPreparationError extends Error {
  override readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AttachmentPreparationError';
    this.cause = cause;
  }
}
