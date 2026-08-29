// Session 附件：列出与内容流式读取。路径不下发；内容只经服务端回传。
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import type { AttachmentStore } from '@ema-agent/attachments';

export interface SessionAttachmentsRouteDeps {
  readonly attachments: AttachmentStore;
}

export const sessionAttachmentsRoute = (deps: SessionAttachmentsRouteDeps) =>
  new Hono()
    // 附件面板直接按 Session 查询，不用 Turn 数量限制截断历史附件。
    .get('/:sessionId/attachments', context => {
      const sessionId = context.req.param('sessionId');
      const attachments = deps.attachments.listBySession(sessionId)
        .map(attachment => ({
          id: attachment.id,
          turnId: attachment.turnId,
          kind: attachment.kind,
          name: attachment.name,
          mimeType: attachment.mimeType,
          createdAt: attachment.createdAt,
        }));
      return context.json({ attachments });
    })
    .get('/:sessionId/attachments/:attachmentId/content', async context => {
      const sessionId = context.req.param('sessionId');
      const attachmentId = context.req.param('attachmentId');
      const attachment = deps.attachments.getMany([attachmentId]).get(attachmentId);
      // 跨 Session 读取按不存在处理，不回显归属差异。
      if (!attachment || attachment.sessionId !== sessionId) {
        return context.json({ error: 'attachment_not_found' }, 404);
      }
      const filePath = attachment.kind === 'image' ? attachment.imagePath : attachment.sourcePath;
      if (!fs.existsSync(filePath)) {
        // 文件附件只记录原路径；用户移动或删除原文件后如实 404。
        return context.json({ error: 'attachment_file_gone' }, 410);
      }
      const stat = await fs.promises.stat(filePath);
      return new Response(
        Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream<Uint8Array>,
        {
          headers: {
            'Content-Type': attachment.mimeType,
            'Content-Length': String(stat.size),
            'Cache-Control': 'private, max-age=3600',
          },
        },
      );
    });
