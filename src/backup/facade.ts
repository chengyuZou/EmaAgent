// 对外提供当前 Session 备份的导入导出入口，并隐藏归档、文件和事务细节。
import type { SessionBackupReader, SessionBackupRestorer } from '@ema-agent/storage';
import { BACKUP_LIMITS } from './limits.js';
import { prepareSessionExport } from './export/prepareSessionExport.js';
import { exportPreparedSession } from './export/sessionExport.js';
import { importSession } from './import/sessionImport.js';
import { SessionImportError } from './import/errors.js';
import type {
  BackupOutputSink,
  OpenedSessionExport,
  SessionBackupCapabilities,
  SessionExportRequest,
  SessionImportRequest,
  SessionImportResult,
} from './types.js';

const CAPABILITIES: SessionBackupCapabilities = Object.freeze({
  importFormats: Object.freeze(['zip'] as const),
  exportFormats: Object.freeze(['zip'] as const),
  streamingArchiveInput: true,
  streamingArchiveOutput: true,
  streamingJsonRecords: true,
  multipartVolumes: false,
  integrityManifest: true,
});

export interface SessionBackupFacadePorts {
  readonly activeDataDir: string;
  readonly reader: SessionBackupReader;
  readonly restorer: SessionBackupRestorer;
  sessionExists(sessionId: string): boolean;
  modelPreferenceExists(providerConfigId: string, modelId: string): boolean;
  kbExists(kbId: string): boolean;
}

export class SessionBackupFacade {
  constructor(private readonly ports: SessionBackupFacadePorts) {}

  capabilities(): SessionBackupCapabilities {
    return CAPABILITIES;
  }

  /**
   * 同步完成一致快照与文件登台,返回已就位的导出;
   * ZIP 本体由调用方决定写向哪里(HTTP 响应、Tauri 文件、测试内存)。
   */
  openSessionExport(request: SessionExportRequest): OpenedSessionExport | null {
    if (request.signal?.aborted) throw new Error('Session 导出已取消');
    const prepared = prepareSessionExport(this.ports.reader, {
      sessionId: request.sessionId,
      activeDataDir: this.ports.activeDataDir,
      generator: 'EmaAgent',
    });
    if (!prepared) return null;
    return {
      filename: prepared.filename,
      mimeType: 'application/zip',
      writeTo: async (sink: BackupOutputSink) => {
        try {
          await exportPreparedSession(prepared, sink, BACKUP_LIMITS);
        } finally {
          prepared.dispose();
        }
      },
    };
  }

  async importSession(request: SessionImportRequest): Promise<SessionImportResult> {
    if (request.format !== undefined && request.format !== 'auto' && request.format !== 'zip') {
      throw new SessionImportError('invalid_format', `不支持备份格式 ${String(request.format)}`);
    }
    const result = await importSession({
      source: request.source,
      activeDataDir: this.ports.activeDataDir,
      restorer: this.ports.restorer,
      sessionExists: sessionId => this.ports.sessionExists(sessionId),
      modelPreferenceExists: this.ports.modelPreferenceExists,
      kbExists: this.ports.kbExists,
      signal: request.signal,
    });
    return { ...result, format: 'zip' };
  }
}
