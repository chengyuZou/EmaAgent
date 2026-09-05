// 测试图片受管副本:原样保留、超限规范化、格式门禁与账本写入。

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { AttachmentImagesRepo, Database } from '@ema-agent/storage';
import { ImageStore } from '../imageStore.js';
import { AttachmentPreparationError } from '../errors.js';
import {
  IMAGE_NORMALIZE_MAX_BYTES,
  IMAGE_NORMALIZE_MAX_DIMENSION,
} from '../limits.js';

const sessionId = 'session-image';

const temporary: string[] = [];
let database: Database;
let dataDir: string;
let repo: AttachmentImagesRepo;
let store: ImageStore;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ema-att-image-'));
  temporary.push(dataDir);
  database = new Database({ memory: true, kind: 'data' });
  database.migrate();
  database.sqlite.prepare(`
    INSERT INTO sessions (id, title, pinned, last_activity_at, created_at, updated_at)
    VALUES (?, 's', 0, 1, 1, 1)
  `).run(sessionId);
  repo = new AttachmentImagesRepo(database.sqlite);
  store = new ImageStore(repo, dataDir);
});

afterEach(() => {
  database.close();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function pngBytes(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).png().toBuffer();
}

describe('ImageStore.saveImage', () => {
  it('未超阈值的图片字节原样落盘并入账', async () => {
    const bytes = await pngBytes(64, 64);
    const saved = await store.saveImage(sessionId, bytes, 'photo.png');

    expect(saved.path).toContain(path.join('attachments', 'images'));
    expect(await readFile(saved.path)).toEqual(bytes);

    const row = repo.listBySession(sessionId)[0];
    expect(row).toMatchObject({
      path: saved.path, name: 'photo.png', byte_size: bytes.length,
    });
  });

  it('边长超 8000 的图被缩进阈值, 落盘的是规范化后的字节', async () => {
    const bytes = await pngBytes(IMAGE_NORMALIZE_MAX_DIMENSION + 500, 100);
    const saved = await store.saveImage(sessionId, bytes, 'wide.png');

    const written = await readFile(saved.path);
    const metadata = await sharp(written).metadata();
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0))
      .toBeLessThanOrEqual(IMAGE_NORMALIZE_MAX_DIMENSION);
    expect(written.equals(bytes)).toBe(false);
  });

  it('字节超 3.75MB 的图被压到阈值内', async () => {
    // 真随机噪声 PNG 几乎不可压缩, 稳定超过字节阈值。
    const noise = randomBytes(1_400 * 1_400 * 4);
    const bytes = await sharp(noise, {
      raw: { width: 1_400, height: 1_400, channels: 4 },
    }).png().toBuffer();
    expect(bytes.length).toBeGreaterThan(IMAGE_NORMALIZE_MAX_BYTES);

    const saved = await store.saveImage(sessionId, bytes, 'noise.png');

    const writtenSize = (await stat(saved.path)).size;
    expect(writtenSize).toBeLessThanOrEqual(IMAGE_NORMALIZE_MAX_BYTES);
  });

  it('无法解码的字节 → AttachmentPreparationError', async () => {
    await expect(store.saveImage(sessionId, Buffer.from('not an image'), 'x.png'))
      .rejects.toBeInstanceOf(AttachmentPreparationError);
  });
});

describe('ImageStore.sweep', () => {
  const AGE_MS = 30 * 24 * 60 * 60 * 1_000;
  const OLD = Date.now() - 60 * 24 * 60 * 60 * 1_000;

  async function putFile(name: string): Promise<string> {
    const filePath = path.join(dataDir, 'sessions', sessionId, 'attachments', 'images', name);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, 'x');
    return filePath;
  }

  it('贴了没发的超龄行删文件销账; 已盖章与年轻的保留', async () => {
    const stale = await putFile('stale.png');
    const stamped = await putFile('stamped.png');
    repo.insertMany([
      { path: stale, session_id: sessionId, name: 's.png', byte_size: 1, created_at: OLD },
      { path: stamped, session_id: sessionId, name: 't.png', byte_size: 1, created_at: OLD },
    ]);
    database.sqlite.prepare(`
      INSERT INTO turns (id, session_id, trigger_type, execution_profile, narrative_policy,
        status, created_at)
      VALUES ('t1', ?, 'userMessage', 'chat', 'off', 'completed', 1)
    `).run(sessionId);
    store.claimForTurn(sessionId, 't1', [stamped]);

    const report = await store.sweep(sessionId, AGE_MS);

    expect(report.deletedFiles).toBe(1);
    expect(repo.listBySession(sessionId).map((row) => row.path)).toEqual([stamped]);
  });

  it('无行的超龄残渣文件删除, 有行的不碰', async () => {
    const residue = await putFile('residue.png');
    const rowed = await putFile('rowed.png');
    const past = (Date.now() - 60 * 24 * 60 * 60 * 1_000) / 1_000;
    utimesSync(residue, past, past);
    utimesSync(rowed, past, past);
    repo.insertMany([{
      path: rowed, session_id: sessionId, name: 'r.png', byte_size: 1, created_at: OLD,
    }]);
    database.sqlite.prepare(`
      INSERT INTO turns (id, session_id, trigger_type, execution_profile, narrative_policy,
        status, created_at)
      VALUES ('t1', ?, 'userMessage', 'chat', 'off', 'completed', 1)
    `).run(sessionId);
    store.claimForTurn(sessionId, 't1', [rowed]);

    const report = await store.sweep(sessionId, AGE_MS);

    expect(report.deletedFiles).toBe(1);
    expect(repo.listBySession(sessionId)).toHaveLength(1);
  });

  it('目录不存在时磁盘侧零查询直接返回账本侧结果', async () => {
    const report = await store.sweep('no-such-session', AGE_MS);
    expect(report).toEqual({ deletedFiles: 0, freedBytes: 0 });
  });
});
