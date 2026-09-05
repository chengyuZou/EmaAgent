// 测试粘贴文本落盘:阈值门禁、utf8 落盘与账本写入。

import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentPastedTextsRepo, Database } from '@ema-agent/storage';
import { PastedTextStore } from '../pasteStore.js';
import { AttachmentPreparationError } from '../errors.js';
import { PASTE_TEXT_MIN_CHARS } from '../limits.js';

const sessionId = 'session-paste';

const temporary: string[] = [];
let database: Database;
let dataDir: string;
let repo: AttachmentPastedTextsRepo;
let store: PastedTextStore;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ema-att-paste-'));
  temporary.push(dataDir);
  database = new Database({ memory: true, kind: 'data' });
  database.migrate();
  database.sqlite.prepare(`
    INSERT INTO sessions (id, title, pinned, last_activity_at, created_at, updated_at)
    VALUES (?, 's', 0, 1, 1, 1)
  `).run(sessionId);
  repo = new AttachmentPastedTextsRepo(database.sqlite);
  store = new PastedTextStore(repo, dataDir);
});

afterEach(() => {
  database.close();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('PastedTextStore.savePastedText', () => {
  it('达到阈值的粘贴落成 txt 并入账, 内容原样可读', async () => {
    const content = '长文本'.repeat(PASTE_TEXT_MIN_CHARS);
    const saved = await store.savePastedText(sessionId, content);

    expect(saved.path).toContain(path.join('attachments', 'pasted'));
    expect(await readFile(saved.path, 'utf8')).toBe(content);
    expect(saved.byteSize).toBe(Buffer.byteLength(content, 'utf8'));
    // 预览是落盘时定格的前若干字符, 供块携带, 组装期零 IO
    expect(saved.preview).toBe(content.slice(0, 500));
    expect(saved.preview.length).toBe(500);

    const row = repo.listBySession(sessionId)[0];
    expect(row).toMatchObject({ path: saved.path, byte_size: saved.byteSize });
  });

  it('低于阈值的粘贴拒绝落盘', async () => {
    await expect(store.savePastedText(sessionId, '短文本'))
      .rejects.toBeInstanceOf(AttachmentPreparationError);
    expect(repo.listBySession(sessionId)).toHaveLength(0);
  });
});

describe('PastedTextStore.sweep', () => {
  const AGE_MS = 30 * 24 * 60 * 60 * 1_000;

  it('贴了没发的超龄行删文件销账; 年轻的保留', async () => {
    const stale = await store.savePastedText(sessionId, '旧'.repeat(PASTE_TEXT_MIN_CHARS));
    const young = await store.savePastedText(sessionId, '新'.repeat(PASTE_TEXT_MIN_CHARS));
    database.sqlite.prepare(
      'UPDATE attachment_pasted_texts SET created_at = ? WHERE path = ?',
    ).run(Date.now() - 60 * 24 * 60 * 60 * 1_000, stale.path);

    const report = await store.sweep(sessionId, AGE_MS);

    expect(report.deletedFiles).toBe(1);
    expect(repo.listBySession(sessionId).map((row) => row.path)).toEqual([young.path]);
  });
});
