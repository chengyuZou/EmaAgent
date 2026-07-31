// 定义当前 Session 备份入口的分块输入、流式输出和结果契约。

export type SessionBackupFormat = 'zip';

export interface BackupArchiveSource {
  readonly declaredSize: number | null;
  chunks(): AsyncIterable<Uint8Array>;
}

export interface BackupOutputSink {
  write(chunk: Uint8Array): Promise<void>;
  commit(): Promise<void>;
  abort(reason: unknown): Promise<void>;
}

export interface SessionImportRequest {
  source: BackupArchiveSource;
  format?: 'auto' | SessionBackupFormat;
  signal?: AbortSignal;
}

export interface SessionImportResult {
  sessionId: string;
  format: SessionBackupFormat;
  warnings: readonly string[];
}

export interface SessionExportRequest {
  sessionId: string;
  signal?: AbortSignal;
}

/**
 * 已就位的导出:文件名已定,ZIP 经 writeTo 流式写入调用方 Sink。
 * Facade 永不把整份 ZIP 聚合进内存,HTTP/Tauri 各自把 Sink 接到自己的响应流。
 */
export interface OpenedSessionExport {
  readonly filename: string;
  readonly mimeType: 'application/zip';
  writeTo(sink: BackupOutputSink): Promise<void>;
}

export interface SessionBackupCapabilities {
  importFormats: readonly SessionBackupFormat[];
  exportFormats: readonly SessionBackupFormat[];
  streamingArchiveInput: true;
  streamingArchiveOutput: true;
  streamingJsonRecords: true;
  multipartVolumes: false;
  integrityManifest: true;
}
