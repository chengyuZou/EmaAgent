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

export interface SessionExportResult {
  format: SessionBackupFormat;
  filename: string;
  mimeType: 'application/zip';
  bytes: Uint8Array;
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
