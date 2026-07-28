// 这里放 Attachment 模块抛出的错误类型：找不到附件、读附件文件失败。

export class AttachmentNotFoundError extends Error {
  constructor(id: string) {
    super(`Attachment not found: ${id}`);
    this.name = 'AttachmentNotFoundError';
  }
}

export class AttachmentFileError extends Error {
  readonly localPath: string;
  override readonly cause: unknown;
  constructor(localPath: string, cause: unknown) {
    super(`Cannot read attachment file: ${localPath}`);
    this.name      = 'AttachmentFileError';
    this.localPath = localPath;
    this.cause     = cause;
  }
}

export class AttachmentLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentLimitError';
  }
}
