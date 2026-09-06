// Session 附件:两本账的列表、按 path 的内容读取,以及粘贴即落盘的两个上传端点。
// path 可以下发——消息块里本来就带 path(chip 靠它渲染),不再做按 id 的间接层。
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ImageStore, PastedTextStore } from '@ema-agent/attachments';
import { AttachmentPreparationError, mimeForPath, PASTE_TEXT_MIN_CHARS } from '@ema-agent/attachments';
import type { SessionStore } from '@ema-agent/session';
import type {
  AttachmentImagesRepo,
  AttachmentPastedTextsRepo,
} from '@ema-agent/storage';
import { jsonBody } from '../validate.js';

export interface SessionAttachmentsRouteDeps {
  readonly sessions: Pick<SessionStore, 'getSession'>;
  readonly attachmentImages: AttachmentImagesRepo;
  readonly attachmentPastedTexts: AttachmentPastedTextsRepo;
  readonly imageStore: ImageStore;
  readonly pasteStore: PastedTextStore;
  readonly activeDataDir: string;
}

const pastedTextBody = z.object({
  content: z.string().min(PASTE_TEXT_MIN_CHARS),
});

const imageBody = z.union([
  z.object({ dataBase64: z.string().min(1), name: z.string().min(1).optional() }),
  z.object({ sourcePath: z.string().min(1), name: z.string().min(1).optional() }),
]);

export const sessionAttachmentsRoute = (deps: SessionAttachmentsRouteDeps) =>
  new Hono()
    .get('/:sessionId/attachments', context => {
      const sessionId = context.req.param('sessionId');
      const missing = ensureSession(deps, context, sessionId);
      if (missing) return missing;
      const images = deps.attachmentImages.listBySession(sessionId)
        .map(row => ({
          kind: 'image' as const,
          path: row.path,
          name: row.name,
          byteSize: row.byte_size,
          createdAt: row.created_at,
        }));
      const pastedTexts = deps.attachmentPastedTexts.listBySession(sessionId)
        .map(row => ({
          kind: 'pasted_text' as const,
          path: row.path,
          name: null,
          byteSize: row.byte_size,
          createdAt: row.created_at,
        }));
      const attachments = [...images, ...pastedTexts]
        .sort((a, b) => b.createdAt - a.createdAt);
      return context.json({ attachments });
    })
    // 内容按 path 读:chip 点开预览与附件页查看共用。边界=必须在该 Session 受管目录内。
    // ?thumb=1 时图片走 256px JPEG 缩略图(消息流封面不拉原图)。
    .get('/:sessionId/attachments/content', async context => {
      const sessionId = context.req.param('sessionId');
      const missing = ensureSession(deps, context, sessionId);
      if (missing) return missing;
      const target = context.req.query('path');
      if (!target || !isInsideManagedDir(deps.activeDataDir, sessionId, target)) {
        return context.json({ error: 'attachment_not_found' }, 404);
      }
      if (context.req.query('thumb') === '1' && mimeForPath(target).startsWith('image/')) {
        try {
          const thumb = await deps.imageStore.readThumbnail(target);
          return new Response(new Uint8Array(thumb), {
            headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' },
          });
        } catch {
          return context.json({ error: 'attachment_file_gone' }, 404);
        }
      }
      let stat;
      try {
        stat = await fs.promises.stat(target);
        if (!stat.isFile()) throw new Error('not a file');
      } catch {
        // 行还在但文件没了(手动删除等)如实 404, 不建对账。
        return context.json({ error: 'attachment_file_gone' }, 404);
      }
      return new Response(
        Readable.toWeb(fs.createReadStream(target)) as ReadableStream<Uint8Array>,
        {
          headers: {
            'Content-Type': mimeForPath(target),
            'Content-Length': String(stat.size),
            'Cache-Control': 'private, max-age=3600',
          },
        },
      );
    })
    // 粘贴大段文本:粘贴那一刻落 txt 入账,输入框立刻出 chip。
    .post('/:sessionId/attachments/pasted', jsonBody(pastedTextBody), async context => {
      const sessionId = context.req.param('sessionId');
      const missing = ensureSession(deps, context, sessionId);
      if (missing) return missing;
      const saved = await deps.pasteStore.savePastedText(
        sessionId,
        context.req.valid('json').content,
      );
      return context.json(saved, 201);
    })
    // 粘贴/拖入图片:剪贴板给字节,拖入给路径由 server 读盘;落盘即规范化入账。
    .post('/:sessionId/attachments/images', jsonBody(imageBody), async context => {
      const sessionId = context.req.param('sessionId');
      const missing = ensureSession(deps, context, sessionId);
      if (missing) return missing;
      const body = context.req.valid('json');
      try {
        const bytes = 'dataBase64' in body
          ? Buffer.from(body.dataBase64, 'base64')
          : await fs.promises.readFile(body.sourcePath);
        const saved = await deps.imageStore.saveImage(sessionId, bytes, body.name);
        return context.json(saved, 201);
      } catch (error) {
        if (error instanceof AttachmentPreparationError) {
          return context.json({ error: 'attachment_rejected', message: error.message }, 400);
        }
        throw error;
      }
    });

function ensureSession(
  deps: SessionAttachmentsRouteDeps,
  context: { json: (body: unknown, status?: number) => Response },
  sessionId: string,
): Response | undefined {
  try {
    deps.sessions.getSession(sessionId);
    return undefined;
  } catch {
    return context.json({ error: 'session_not_found' }, 404);
  }
}

function isInsideManagedDir(activeDataDir: string, sessionId: string, target: string): boolean {
  const dir = path.join(activeDataDir, 'sessions', sessionId, 'attachments');
  const relative = path.relative(dir, path.resolve(target));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}
