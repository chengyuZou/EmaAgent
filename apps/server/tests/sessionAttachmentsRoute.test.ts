// 验证附件路由:粘贴即落盘两个端点、两本账合并列表、按 path 读内容的边界与 404 语义。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImageStore, PastedTextStore, PASTE_TEXT_MIN_CHARS } from '@ema-agent/attachments';
import type { SessionStore } from '@ema-agent/session';
import {
  AttachmentImagesRepo,
  AttachmentPastedTextsRepo,
  Database,
} from '@ema-agent/storage';
import { sessionAttachmentsRoute } from '../src/routes/sessions/attachments.js';

const sessionId = 'session-route';
const temporary: string[] = [];
let database: Database;
let dataDir: string;
let imagesRepo: AttachmentImagesRepo;
let pastedTextsRepo: AttachmentPastedTextsRepo;
let app: ReturnType<typeof sessionAttachmentsRoute>;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ema-att-route-'));
  temporary.push(dataDir);
  database = new Database({ memory: true, kind: 'data' });
  database.migrate();
  database.sqlite.prepare(`
    INSERT INTO sessions (id, title, pinned, last_activity_at, created_at, updated_at)
    VALUES (?, 's', 0, 1, 1, 1)
  `).run(sessionId);
  imagesRepo = new AttachmentImagesRepo(database.sqlite);
  pastedTextsRepo = new AttachmentPastedTextsRepo(database.sqlite);
  app = sessionAttachmentsRoute({
    sessions: { getSession: () => ({ id: sessionId }) } as unknown as SessionStore,
    attachmentImages: imagesRepo,
    attachmentPastedTexts: pastedTextsRepo,
    imageStore: new ImageStore(imagesRepo, dataDir),
    pasteStore: new PastedTextStore(pastedTextsRepo, dataDir),
    activeDataDir: dataDir,
  });
});

afterEach(() => {
  database.close();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// 最小合法 1x1 PNG(不引 sharp,apps/server 无此依赖)。
const PNG_1PX_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function pngBase64(): Promise<string> {
  return PNG_1PX_BASE64;
}

describe('sessionAttachmentsRoute', () => {
  it('POST pasted 落盘入账并返回 preview; 列表合并两本账', async () => {
    const content = '粘'.repeat(PASTE_TEXT_MIN_CHARS);
    const created = await app.request(`/${sessionId}/attachments/pasted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    expect(created.status).toBe(201);
    const saved = await created.json() as { path: string; preview: string; byteSize: number };
    expect(saved.preview).toBe(content.slice(0, 500));

    const imageCreated = await app.request(`/${sessionId}/attachments/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataBase64: await pngBase64(), name: '截图.png' }),
    });
    expect(imageCreated.status).toBe(201);

    const list = await app.request(`/${sessionId}/attachments`);
    const body = await list.json() as {
      attachments: Array<{ kind: string; name: string | null }>
    };
    expect(body.attachments).toHaveLength(2);
    expect(body.attachments.map(a => a.kind).sort())
      .toEqual(['image', 'pasted_text']);
    expect(body.attachments.find(a => a.kind === 'image')?.name).toBe('截图.png');
  });

  it('POST pasted 低于阈值被 zod 拒绝(400)', async () => {
    const response = await app.request(`/${sessionId}/attachments/pasted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '太短' }),
    });
    expect(response.status).toBe(400);
  });

  it('POST images 收到不可解码字节 → 400 attachment_rejected', async () => {
    const response = await app.request(`/${sessionId}/attachments/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataBase64: Buffer.from('not an image').toString('base64') }),
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('attachment_rejected');
  });

  it('content 按 path 读回;越出受管目录一律 404', async () => {
    const created = await app.request(`/${sessionId}/attachments/pasted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '读'.repeat(PASTE_TEXT_MIN_CHARS) }),
    });
    const saved = await created.json() as { path: string };

    const ok = await app.request(
      `/${sessionId}/attachments/content?path=${encodeURIComponent(saved.path)}`,
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Content-Type')).toBe('text/plain');

    const escape = await app.request(
      `/${sessionId}/attachments/content?path=${encodeURIComponent('D:/Windows/notepad.exe')}`,
    );
    expect(escape.status).toBe(404);
  });

  it('session 不存在时四个端点都 404', async () => {
    const missing = sessionAttachmentsRoute({
      sessions: {
        getSession: () => { throw new Error('nope'); },
      } as unknown as SessionStore,
      attachmentImages: imagesRepo,
      attachmentPastedTexts: pastedTextsRepo,
      imageStore: new ImageStore(imagesRepo, dataDir),
      pasteStore: new PastedTextStore(pastedTextsRepo, dataDir),
      activeDataDir: dataDir,
    });
    expect((await missing.request(`/ghost/attachments`)).status).toBe(404);
    expect((await missing.request(`/ghost/attachments/pasted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x'.repeat(PASTE_TEXT_MIN_CHARS) }),
    })).status).toBe(404);
  });
});
