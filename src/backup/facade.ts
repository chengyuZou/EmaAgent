// 对外提供当前 Session 备份的导入导出入口，并隐藏归档、文件和事务细节。
import type { SessionBackupReader, SessionBackupRestorer } from '@ema-agent/storage';
import { BACKUP_LIMITS } from './limits.js';
import { prepareSessionExport } from './export/prepareSessionExport.js';
import { exportPreparedSession } from './export/sessionExport.js';
import { importSession } from './import/sessionImport.js';
import { SessionImportError } from './import/errors.js';
import type {
  BackupOutputSink,
  SessionBackupCapabilities,
  SessionExportRequest,
  SessionExportResult,
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
  modelPreferenceExists?(providerConfigId: string, modelId: string): boolean;
  kbExists?(kbId: string): boolean;
}

export class SessionBackupFacade {
  constructor(private readonly ports: SessionBackupFacadePorts) {}

  capabilities(): SessionBackupCapabilities {
    return CAPABILITIES;
  }

  async exportSession(request: SessionExportRequest): Promise<SessionExportResult | null> {
    if (request.signal?.aborted) throw new Error('Session 导出已取消');
    const prepared = prepareSessionExport(this.ports.reader, {
      sessionId: request.sessionId,
      activeDataDir: this.ports.activeDataDir,
      generator: 'EmaAgent',
    });
    if (!prepared) return null;
    const sink = memorySink();
    try {
      await exportPreparedSession(prepared, sink, BACKUP_LIMITS);
      return {
        format: 'zip',
        filename: `ema-session-${safeFilename(request.sessionId)}.zip`,
        mimeType: 'application/zip',
        bytes: joinChunks(sink.chunks),
      };
    } finally {
      prepared.dispose();
    }
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

function memorySink(): BackupOutputSink & { readonly chunks: Uint8Array[] } {
  const chunks: Uint8Array[] = [];
  return {
    chunks,
    write: async chunk => { chunks.push(new Uint8Array(chunk)); },
    commit: async () => {},
    abort: async () => { chunks.length = 0; },
  };
}

function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'session';
}
