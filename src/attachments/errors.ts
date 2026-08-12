// Attachments 对外需要识别的业务错误：输入限额与附件准备失败。

/** 图片数量/字节或文件数量超过本 Turn 限额。 */
export class AttachmentLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentLimitError';
  }
}

/** 路径不存在、不是普通文件、读取失败或受管副本写入失败。 */
export class AttachmentPreparationError extends Error {
  override readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AttachmentPreparationError';
    this.cause = cause;
  }
}
