/** 路径不存在、不是普通文件、越出受管目录、账本缺行、图片无法解码或落盘失败。 */
export class AttachmentPreparationError extends Error {
  override readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AttachmentPreparationError';
    this.cause = cause;
  }
}
