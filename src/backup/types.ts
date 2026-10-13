export interface SessionExportResult {
  /** ZIP 已写完并关闭, 该路径可直接用于文件定位. */
  readonly filePath: string;
  readonly warnings: readonly string[];
}

export interface SessionImportResult {
  readonly sessionId: string;
  readonly warnings: readonly string[];
}
