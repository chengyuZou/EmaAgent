// 列出 Session 的持久附件及其当前文件状态，并签发受控读取句柄。
import { Hono } from 'hono';
import { asSessionId } from '@ema-agent/ids';
import type { AttachmentStorePort, FileAccessFacade } from '@ema-agent/attachment';
import type { SessionAttachmentsResult, SessionStore } from '@ema-agent/session';
import { issueStoredFileHandle } from './attachmentProjection.js';

export function sessionAttachmentsRoute(
  session: Pick<SessionStore, 'getSession'>,
  attachments: Pick<AttachmentStorePort, 'inspectBySession'>,
  fileAccess: Pick<FileAccessFacade, 'issue'>,
): Hono {
  const app = new Hono();

  app.get('/:id/attachments', async (c) => {
    const sessionId = asSessionId(c.req.param('id'));
    try {
      // 不存在的 Session 必须返回 404，不能伪装成“附件为空”。
      session.getSession(sessionId);
      const inspected = await attachments.inspectBySession(sessionId);
      return c.json({
        attachments: inspected.map((attachment) => ({
          id: attachment.id,
          turnId: attachment.turnId,
          sessionId: attachment.sessionId,
          name: attachment.name,
          mimeType: attachment.mime,
          size: attachment.size,
          mtime: attachment.mtime,
          fileHandle: issueStoredFileHandle(fileAccess, attachment.localPath),
          createdAt: attachment.createdAt,
          fileStatus: attachment.fileStatus,
        })),
      } satisfies SessionAttachmentsResult);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('session_not_found')) {
        return c.json({ error: 'session_not_found' }, 404);
      }
      throw error;
    }
  });

  return app;
}
