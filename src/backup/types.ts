// 定义 Session 备份 Facade 的输入输出、能力和文件端口。
import type { SessionRestorePayload } from '@ema-agent/storage';

/** 导入备份时跳过尚未发布功能所产生的提示。 */
export interface ImportWarningWire {
  readonly code: 'unsupported_feature';
  readonly feature: 'artifacts';
  readonly message: string;
}

export type SessionBackupFormat = 'zip-v1';

/**
 * Core/CLI/Tauri 都通过同一个分块输入端口提交备份，不把 Web File 类型带进业务包。
 * V1 会受限聚合压缩输入；ZIP v2 可直接消费相同 chunks() 而无需修改调用方。
 */
export interface BackupArchiveSource {
  readonly declaredSize: number | null;
  chunks(): AsyncIterable<Uint8Array>;
}

export interface SessionImportRequest {
  source: BackupArchiveSource;
  format?: 'auto' | SessionBackupFormat;
  signal?: AbortSignal;
}

export interface SessionImportResult {
  sessionId: string;
  format: SessionBackupFormat;
  warnings: ImportWarningWire[];
}

export interface BackupArtifactExportEntry {
  id: string; type: string; title: string; contentLocation: string;
  content?: string | null; contentPath?: string | null; turnId?: string | null;
  createdAt: number; appliedAt?: number | null; rejectedAt?: number | null;
}

export interface BackupAttachmentExportEntry {
  id: string; name: string; mime: string; size: number; turnId: string;
  mtime: number; createdAt: number; localPath?: string | null;
}

export interface BackupAudioExportEntry {
  turn_id: string; mime_type: string; byte_size: number;
  duration_ms: number | null; segment_count: number; created_at: number;
  storage_path: string | null;
}

export interface SessionExportSnapshot {
  session: { id: string; title: string } & Record<string, unknown>;
  turns: readonly unknown[];
  messages: readonly unknown[];
  artifacts: readonly BackupArtifactExportEntry[];
  attachments: readonly BackupAttachmentExportEntry[];
  audio: readonly BackupAudioExportEntry[];
  notes: unknown | null;
  tasks: readonly unknown[];
  taskDependencies: readonly unknown[];
  agentRuns: readonly unknown[];
  agentRunMessages: readonly unknown[];
  memoryState: unknown | null;
  kbActivations: readonly unknown[];
  usageRecords: readonly unknown[];
}

export interface SessionExportRequest { sessionId: string; }
export interface SessionExportResult {
  format: SessionBackupFormat;
  filename: string;
  mimeType: 'application/zip';
  bytes: Uint8Array;
}

/** 当前运行时能力；false 项是稳定的演进插槽，不代表半成品已经接线。 */
export interface SessionBackupCapabilities {
  importFormats: readonly SessionBackupFormat[];
  exportFormats: readonly SessionBackupFormat[];
  streamingArchiveInput: boolean;
  streamingArchiveOutput: boolean;
  streamingJsonRecords: boolean;
  multipartVolumes: boolean;
  integrityManifest: boolean;
}

/**
 * ZIP v2 导出将写向此端口，目标可以是 HTTP Response、Tauri 文件或分卷器。
 * 当前只导出端口契约，不宣称 SessionBackupFacade 已实现流式导出。
 */
export interface BackupOutputSink {
  write(chunk: Uint8Array): Promise<void>;
  commit(): Promise<void>;
  abort(reason: unknown): Promise<void>;
}

export interface SessionBackupPorts {
  readonly activeDataDir: string;
  readonly artifactsEnabled: boolean;
  sessionExists(sessionId: string): boolean;
  restoreRows(payload: SessionRestorePayload): void;
  collectExport(sessionId: string): SessionExportSnapshot | null;
}
