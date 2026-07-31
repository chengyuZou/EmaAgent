// 备份导出边界的结构化错误,超限导出必须硬失败而不是降级成警告。
export type SessionExportErrorCode = 'export_too_large' | 'export_failed';

export class SessionExportError extends Error {
  constructor(
    readonly code: SessionExportErrorCode,
    message: string,
    readonly status: 413 | 500 = code === 'export_too_large' ? 413 : 500,
  ) {
    super(message);
    this.name = 'SessionExportError';
  }
}
