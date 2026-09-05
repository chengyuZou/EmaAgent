// 测试 Vision 描述缓存:path 键的两层命中、同键并发去重、空描述拒绝与空闲维护。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AttachmentImagesRepo,
  AttachmentVisionDescriptionCachesRepo,
  Database,
} from '@ema-agent/storage';
import { VisionDescriptionCache } from '../visionCache.js';

const sessionId = 'session-cache';

let database: Database;
let dataDir: string;
let imagesRepo: AttachmentImagesRepo;
let repo: AttachmentVisionDescriptionCachesRepo;
let imagePath: string;
const temporary: string[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ema-att-cache-'));
  temporary.push(dataDir);
  database = new Database({ memory: true, kind: 'data' });
  database.migrate();
  database.sqlite.prepare(`
    INSERT INTO sessions (id, title, pinned, last_activity_at, created_at, updated_at)
    VALUES (?, 's', 0, 1, 1, 1)
  `).run(sessionId);

  imagesRepo = new AttachmentImagesRepo(database.sqlite);
  repo = new AttachmentVisionDescriptionCachesRepo(database.sqlite);
  imagePath = path.join(dataDir, 'managed-a.png');
  insertImageRow(imagePath);
});

afterEach(() => {
  database.close();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function insertImageRow(target: string): void {
  imagesRepo.insertMany([{
    path: target, session_id: sessionId, name: 'a.png', byte_size: 3, created_at: 1,
  }]);
}

const signal = () => new AbortController().signal;

describe('VisionDescriptionCache', () => {
  it('并发同键只生产一次;重启实例后从 SQLite 复用', async () => {
    const cache = new VisionDescriptionCache(repo);
    const producer = vi.fn(async () => '一只粉色的猫');

    const [first, concurrent] = await Promise.all([
      cache.getOrCreate(imagePath, signal(), producer),
      cache.getOrCreate(imagePath, signal(), producer),
    ]);
    expect(first).toBe('一只粉色的猫');
    expect(concurrent).toBe('一只粉色的猫');
    expect(producer).toHaveBeenCalledTimes(1);
    expect(producer).toHaveBeenCalledWith(imagePath);

    const restarted = new VisionDescriptionCache(repo);
    const disk = await restarted.getOrCreate(imagePath, signal(), producer);
    expect(disk).toBe('一只粉色的猫');
    expect(producer).toHaveBeenCalledTimes(1);
  });

  it('换 Vision 模型后旧描述保留继续用', async () => {
    const cache = new VisionDescriptionCache(repo);
    await cache.getOrCreate(imagePath, signal(), async () => 'v1 描述');

    const v2 = await cache.getOrCreate(imagePath, signal(), async () => 'v2 描述');
    expect(v2).toBe('v1 描述');
  });

  it('空描述拒绝入缓存', async () => {
    const cache = new VisionDescriptionCache(repo);
    await expect(cache.getOrCreate(imagePath, signal(), async () => '   '))
      .rejects.toThrow('Vision');
    expect(repo.totalBytes()).toBe(0);
  });

  it('图片账本行删除时描述级联消失', async () => {
    const cache = new VisionDescriptionCache(repo);
    await cache.getOrCreate(imagePath, signal(), async () => '描述');

    imagesRepo.deleteByPaths([imagePath]);
    expect(repo.find(imagePath)).toBeUndefined();
  });
});

describe('VisionDescriptionCache.sweepIfIdle', () => {
  it('不空闲不清理;空闲时按 TTL 删除过期描述', async () => {
    const cache = new VisionDescriptionCache(repo);
    await cache.getOrCreate(imagePath, signal(), async () => '描述');

    let idle = false;
    const options = {
      isIdle: () => idle,
      maxBytesForSweep: () => 1024 * 1024,
    };
    expect((await cache.sweepIfIdle(options)).ran).toBe(false);

    database.sqlite.prepare(
      'UPDATE attachment_vision_descriptions_caches SET last_accessed_at = 1',
    ).run();
    idle = true;
    // 越过最小间隔, 确保真正跑一轮
    const report = await cache.sweepIfIdle(options, Date.now() + 7 * 60 * 60 * 1_000);
    expect(report.ran).toBe(true);
    expect(report.deletedDescriptions).toBe(1);
    expect(repo.totalBytes()).toBe(0);
  });

  it('超过预算时从最久未访问开始驱逐', async () => {
    const cache = new VisionDescriptionCache(repo);
    await cache.getOrCreate(imagePath, signal(), async () => '旧描述');
    const secondPath = path.join(dataDir, 'managed-b.png');
    insertImageRow(secondPath);
    await cache.getOrCreate(secondPath, signal(), async () => '新描述');
    database.sqlite.prepare(
      'UPDATE attachment_vision_descriptions_caches SET last_accessed_at = ? WHERE path = ?',
    ).run(Date.now() - 1_000, imagePath);
    database.sqlite.prepare(
      'UPDATE attachment_vision_descriptions_caches SET last_accessed_at = ? WHERE path = ?',
    ).run(Date.now(), secondPath);

    const total = repo.totalBytes();
    // 预算设为低于总量 => 驱逐最旧的一条
    const report = await cache.sweepIfIdle({
      isIdle: () => true,
      maxBytesForSweep: () => total - 1,
    });
    expect(report.ran).toBe(true);
    expect(report.deletedDescriptions).toBe(1);
    expect(repo.find(imagePath)).toBeUndefined();
    expect(repo.find(secondPath)).toBeDefined();
  });
});
