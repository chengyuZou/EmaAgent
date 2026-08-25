// Session 附件：列出与内容流式读取。路径不进 wire；内容只经服务端回传。
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import type { AttachmentStore } from '@ema-agent/attachments';
import type { TurnStore } from '@ema-agent/turn';

export interface SessionAttachmentsRouteDeps {
  readonly attachments: AttachmentStore;
  readonly turns: Pick<TurnStore, 'listTurns'>;
}

export const sessionAttachmentsRoute = (deps: SessionAttachmentsRouteDeps) =>
  new Hono()
    // 附件面板：按 Turn 聚合该 Session 的全部附件（AttachmentStore 的查询单位是 Turn）。
    .get('/:sessionId/attachments', context => {
      const sessionId = context.req.param('sessionId');
      const attachments = deps.turns.listTurns(sessionId, 500)
        .flatMap(turn => deps.attachments.listByTurn(turn.id))
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
