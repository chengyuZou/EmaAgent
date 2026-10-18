import fs from 'node:fs';
import path from 'node:path';
import type { SessionBackupReader, SessionBackupRestorer } from '@ema-agent/storage';
import type { SessionExportResult, SessionImportResult } from './types.js';
import { exportSessionArchive } from './export/sessionExport.js';
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
    // 一个数据目录只创建一个实例. 此处清理上次异常退出遗留的临时文件.
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    this.exportTemporaryRoot = path.join(temporaryRoot, 'exports');
    this.importTemporaryRoot = path.join(temporaryRoot, 'imports');
    fs.mkdirSync(this.exportTemporaryRoot, { recursive: true });
    fs.mkdirSync(this.importTemporaryRoot, { recursive: true });
  }

  /** 路径属于运行后端的本机; 返回结果时 ZIP 已保存, 不是等待前端下载. */
  exportSession(
    sessionId: string,
    destinationPath: string,
    signal?: AbortSignal,
  ): Promise<SessionExportResult> {
    return exportSessionArchive(
      sessionId,
      destinationPath,
      this.activeDataDir,
      this.exportTemporaryRoot,
      this.reader,
      signal,
    );
  }

  importSession(filePath: string, signal?: AbortSignal): Promise<SessionImportResult> {
    return importSessionArchive(
      filePath,
      this.activeDataDir,
      this.importTemporaryRoot,
      this.reader,
      this.restorer,
      this.modelSelectionExists,
      signal,
    );
  }
}
