// 文件由本机后端读取或写入; HTTP 只传路径和完成结果, 不传 ZIP 字节.
import path from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  SessionExportError,
  SessionImportError,
  type SessionBackup,
} from '@ema-agent/backup';
import { jsonBody } from '../validate.js';

const absoluteFilePath = z.string().min(1).refine(
  value => path.isAbsolute(value) && !value.includes('\0'),
  { message: '请选择本机文件的绝对路径' },
);

const exportBody = z.object({ destinationPath: absoluteFilePath }).strict();
const importBody = z.object({ filePath: absoluteFilePath }).strict();

export interface SessionBackupRouteDeps {
  readonly backup: Pick<SessionBackup, 'exportSession' | 'importSession'>;
  readonly onImported: (sessionId: string) => void;
}

export const sessionBackupRoute = (deps: SessionBackupRouteDeps) =>
  new Hono()
    .post('/:sessionId/export', jsonBody(exportBody), async context => {
      try {
        const { destinationPath } = context.req.valid('json');
        const result = await deps.backup.exportSession(
          context.req.param('sessionId'),
          destinationPath,
          context.req.raw.signal,
        );
        return context.json(result);
      } catch (error) {
        if (error instanceof SessionExportError) {
          return context.json(
            { error: error.code, message: error.message },
            honoStatus(error.status),
          );
        }
        throw error;
      }
    })
    .post('/import', jsonBody(importBody), async context => {
      try {
        const { filePath } = context.req.valid('json');
        const result = await deps.backup.importSession(filePath, context.req.raw.signal);
        deps.onImported(result.sessionId);
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

/** 499 不在 Hono 状态码表内; 客户端取消时按 500 返回, 保留错误码供调用方识别. */
function honoStatus(status: 400 | 404 | 409 | 413 | 499 | 500): 400 | 404 | 409 | 413 | 500 {
  return status === 499 ? 500 : status;
}
