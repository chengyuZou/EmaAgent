// 组织一次 Session 导出，并确保临时文件在写入成功或失败后都被删除。
import type { SessionBackupReader } from '@ema-agent/storage';
import type { SessionExport } from '../types.js';
import { SessionExportError } from '../errors.js';
import { stageSessionExport, type StagedSessionExport } from './stageSessionExport.js';
import { writeStreamingZip } from './streamingZip.js';

export function createSessionExport(
  sessionId: string,
  activeDataDir: string,
  temporaryRoot: string,
  reader: SessionBackupReader,
  signal?: AbortSignal,
): SessionExport | null {
  if (!reader.hasSession(sessionId)) return null;
  return {
    filename: `${safeFilename(sessionId)}.ema-session.zip`,
    mimeType: 'application/zip',
    async writeTo(output): Promise<void> {
      // staging 也在同一个 try 里：记录写盘或复制失败的原始错误同样要映射为类型化导出错误。
      let staged: StagedSessionExport | null = null;
      try {
        staged = stageSessionExport(sessionId, activeDataDir, temporaryRoot, reader, signal);
        if (!staged) throw new SessionExportError('session_not_found', 'Session 不存在', 404);
        await writeStreamingZip(staged.entries(), output, signal);
      } catch (error) {
        if (signal?.aborted) {
          throw new SessionExportError('export_cancelled', 'Session 导出已取消', 499);
        }
        if (error instanceof SessionExportError) throw error;
        throw new SessionExportError(
          'export_failed',
          error instanceof Error ? error.message : 'Session 导出失败',
        );
      } finally {
        staged?.dispose();
      }
    },
  };
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}
