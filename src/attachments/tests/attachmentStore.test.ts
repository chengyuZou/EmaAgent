// 测试附件总入口:attach 的 file 权威化与盖章转发, sweep 的并发编排与分侧结算。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AttachmentImagesRepo,
  AttachmentPastedTextsRepo,
  Database,
} from '@ema-agent/storage';
import { AttachmentStore } from '../attachmentStore.js';
import { ImageStore } from '../imageStore.js';
import { PastedTextStore } from '../pasteStore.js';
import { AttachmentPreparationError } from '../errors.js';

const sessionId = 'session-att';
const turnId = 'turn-att';

const temporary: string[] = [];
let database: Database;
let dataDir: string;
let imagesRepo: AttachmentImagesRepo;
let pastedTextsRepo: AttachmentPastedTextsRepo;
let imageStore: ImageStore;
let pasteStore: PastedTextStore;
let store: AttachmentStore;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ema-att-store-'));
  temporary.push(dataDir);
  database = new Database({ memory: true, kind: 'data' });
  database.migrate();
  database.sqlite.prepare(`
    INSERT INTO sessions (id, title, pinned, last_activity_at, created_at, updated_at)
    VALUES (?, 's', 0, 1, 1, 1)
  `).run(sessionId);
  database.sqlite.prepare(`
    INSERT INTO turns (id, session_id, trigger_type, execution_profile, narrative_policy,
      status, created_at)
    VALUES (?, ?, 'userMessage', 'chat', 'off', 'completed', 1)
  `).run(turnId, sessionId);
  imagesRepo = new AttachmentImagesRepo(database.sqlite);
  pastedTextsRepo = new AttachmentPastedTextsRepo(database.sqlite);
  imageStore = new ImageStore(imagesRepo, dataDir);
  pasteStore = new PastedTextStore(pastedTextsRepo, dataDir);
  store = new AttachmentStore({ imageStore, pasteStore });
});

afterEach(() => {
  database.close();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('AttachmentStore.attach', () => {
  it('file 块 realpath 权威化后原样成块', async () => {
    const source = path.join(dataDir, 'notes.txt');
    writeFileSync(source, 'hello');
    const [block] = await store.attach(sessionId, turnId, [
      { type: 'file_reference', path: source },
    ]);
    expect(block).toEqual({ type: 'file_reference', path: source });
  });

  it('file 块路径不存在 → 硬失败', async () => {
    await expect(store.attach(sessionId, turnId, [
      { type: 'file_reference', path: path.join(dataDir, 'nope.txt') },
    ])).rejects.toBeInstanceOf(AttachmentPreparationError);
  });

  it('image/pasted 块盖章: NULL 行被标记到当前 Turn', async () => {
    imagesRepo.insertMany([{
      path: 'a.png', session_id: sessionId, name: 'a.png', byte_size: 10, created_at: 1,
    }]);
    pastedTextsRepo.insert({
      path: 'b.txt', session_id: sessionId, byte_size: 3, created_at: 1,
    });

    const result = await store.attach(sessionId, turnId, [
      { type: 'image_reference', path: 'a.png' },
      { type: 'pasted_text_reference', path: 'b.txt' },
    ]);

    expect(result).toHaveLength(2);
    expect(imagesRepo.listBySession(sessionId)[0]?.turn_id).toBe(turnId);
    expect(pastedTextsRepo.listBySession(sessionId)[0]?.turn_id).toBe(turnId);
  });

  it('账本缺行或跨 Session → 硬失败', async () => {
    await expect(store.attach(sessionId, turnId, [
      { type: 'image_reference', path: 'ghost.png' },
    ])).rejects.toBeInstanceOf(AttachmentPreparationError);
  });
});

describe('AttachmentStore.sweep', () => {
  const AGE_MS = 30 * 24 * 60 * 60 * 1_000;

  it('并发编排两侧并按侧结算', async () => {
    imagesRepo.insertMany([{
      path: 'stale.png', session_id: sessionId, name: 's.png', byte_size: 9,
      created_at: Date.now() - 60 * 24 * 60 * 60 * 1_000,
    }]);

    const report = await store.sweep(sessionId, AGE_MS);

    expect(report.images.status).toBe('fulfilled');
    expect(report.pasted.status).toBe('fulfilled');
    if (report.images.status === 'fulfilled') {
      expect(report.images.value.deletedFiles).toBe(1);
    }
    expect(imagesRepo.listBySession(sessionId)).toHaveLength(0);
  });

  it('一侧炸了另一侧的结果照样收', async () => {
    imagesRepo.insertMany([{
      path: 'stale.png', session_id: sessionId, name: 's.png', byte_size: 9,
      created_at: Date.now() - 60 * 24 * 60 * 60 * 1_000,
    }]);
    vi.spyOn(pasteStore, 'sweep').mockRejectedValue(new Error('磁盘炸了'));

    const report = await store.sweep(sessionId, AGE_MS);

    expect(report.pasted.status).toBe('rejected');
    expect(report.images.status).toBe('fulfilled');
    if (report.images.status === 'fulfilled') {
      expect(report.images.value.deletedFiles).toBe(1);
    }
  });
});
