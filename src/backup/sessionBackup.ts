// 提供 Session ZIP 导入导出的唯一业务入口，并在开机时清理上次遗留的临时目录。
import fs from 'node:fs';
import path from 'node:path';
import type { SessionBackupReader, SessionBackupRestorer } from '@ema-agent/storage';
import type { BackupArchiveSource, SessionExport, SessionImportResult } from './types.js';
import { createSessionExport } from './export/sessionExport.js';
import { importSessionArchive } from './import/sessionImport.js';

export class SessionBackup {
  private readonly exportTemporaryRoot: string;
  private readonly importTemporaryRoot: string;

  constructor(
    private readonly activeDataDir: string,
    private readonly reader: SessionBackupReader,
    private readonly restorer: SessionBackupRestorer,
    private readonly modelSelectionExists: (providerId: string, modelId: string) => boolean,
  ) {
    const temporaryRoot = path.join(activeDataDir, '.backup-temp');
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    this.exportTemporaryRoot = path.join(temporaryRoot, 'exports');
    this.importTemporaryRoot = path.join(temporaryRoot, 'imports');
    fs.mkdirSync(this.exportTemporaryRoot, { recursive: true });
    fs.mkdirSync(this.importTemporaryRoot, { recursive: true });
  }

  exportSession(sessionId: string, signal?: AbortSignal): SessionExport | null {
    return createSessionExport(
      sessionId,
      this.activeDataDir,
      this.exportTemporaryRoot,
      this.reader,
      signal,
    );
  }

  importSession(source: BackupArchiveSource, signal?: AbortSignal): Promise<SessionImportResult> {
    return importSessionArchive(
      source,
      this.activeDataDir,
      this.importTemporaryRoot,
      this.reader,
      this.restorer,
      this.modelSelectionExists,
      signal,
    );
  }
}
