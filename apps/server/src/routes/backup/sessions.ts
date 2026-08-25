// Session 便携备份：单 Session ZIP 导出（流式下载）与导入（multipart 上传）。
// backup 是独立业务域（未来还有角色/设置等备份），本文件只是 Session 这一支；
// 路由形状仍挂在 /api/sessions 下（/:id/export、/import），文件归属不等于 URL 前缀。
import { Hono } from 'hono';
import {
  SessionExportError,
  SessionImportError,
  type BackupArchiveSource,
  type BackupOutput,
  type SessionBackup,
} from '@ema-agent/backup';

export interface SessionBackupRouteDeps {
  readonly backup: SessionBackup;
}

export const sessionBackupRoute = (deps: SessionBackupRouteDeps) =>
  new Hono()
    // 导出：不存在即 404；writeTo 全程流式，不把 ZIP 放进内存。
    .post('/:id/export', async context => {
    const sessionExport = deps.backup.exportSession(
      context.req.param('id'),
      context.req.raw.signal,
    );
    if (!sessionExport) return context.json({ error: 'session_not_found' }, 404);

    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; },
    });
    const output: BackupOutput = {
      write: async chunk => { streamController.enqueue(chunk); },
      complete: async () => { streamController.close(); },
      fail: async reason => { streamController.error(reason); },
    };

    try {
      await sessionExport.writeTo(output);
    } catch (error) {
      if (error instanceof SessionExportError) {
        return context.json(
          { error: error.code, message: error.message },
          honoStatus(error.status),
        );
      }
      throw error;
    }

    return new Response(stream, {
      headers: {
        'Content-Type': sessionExport.mimeType,
        'Content-Disposition': `attachment; filename="${sessionExport.filename}"`,
        'Cache-Control': 'no-store',
      },
    });
    })
    // 导入：multipart 的 file 字段是 ZIP 本体；目标已有同 id Session 时 409。
    .post('/import', async context => {
    const form = await context.req.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File) || file.size === 0) {
      return context.json({ error: 'invalid_archive' }, 400);
    }
    const source: BackupArchiveSource = {
      declaredBytes: file.size,
      chunks: async function* () {
        const reader = file.stream().getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            if (value) yield value;
          }
        } finally {
          reader.releaseLock();
        }
      },
    };
    try {
      const result = await deps.backup.importSession(source, context.req.raw.signal);
      return context.json(result, 201);
    } catch (error) {
      if (error instanceof SessionImportError) {
        return context.json(
          { error: error.code, message: error.message },
          honoStatus(error.status),
        );
      }
      throw error;
    }
    });

/** 499（客户端取消）不在 Hono 状态码表内；取消时客户端已断开，响应落 500 无人读。 */
function honoStatus(status: 400 | 404 | 409 | 413 | 499 | 500): 400 | 404 | 409 | 413 | 500 {
  return status === 499 ? 500 : status;
}
