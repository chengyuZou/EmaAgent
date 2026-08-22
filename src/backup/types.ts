export interface BackupArchiveSource {
  readonly declaredBytes: number | null;
  chunks(): AsyncIterable<Uint8Array>;
}

export interface BackupOutput {
  write(chunk: Uint8Array): Promise<void>;
  complete(): Promise<void>;
  fail(reason: unknown): Promise<void>;
}

/** 单次导出只能写入一个输出目标。 */
export interface SessionExport {
  readonly filename: string;
  readonly mimeType: 'application/zip';
  writeTo(output: BackupOutput): Promise<void>;
}

export interface SessionImportResult {
  readonly sessionId: string;
  readonly warnings: readonly string[];
}
