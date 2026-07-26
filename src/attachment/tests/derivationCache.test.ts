// 测试图片规范化、Vision 派生复用和仅在空闲时执行的本地缓存回收。
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AttachmentDerivationsRepo,
  Database,
} from '@ema-agent/storage';
import { AttachmentDerivationCache } from '../derivations/cache.js';
import { AttachmentCacheMaintenance } from '../derivations/maintenance.js';

describe('Attachment Vision 派生缓存', () => {
  let dataDir: string;
  let database: Database;
  let repo: AttachmentDerivationsRepo;
  let source: Uint8Array;

  beforeEach(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'ema-attachment-cache-'));
    database = new Database({ memory: true, kind: 'data' });
    database.migrate();
    repo = new AttachmentDerivationsRepo(database.sqlite);
    source = new Uint8Array(await sharp({
      create: {
        width: 32,
        height: 24,
        channels: 3,
        background: '#ff3366',
      },
    }).png().toBuffer());
  });

  afterEach(() => {
    database.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('并发请求只调用一次 Vision，跨缓存实例从磁盘复用', async () => {
    const producer = vi.fn(async () => '粉色测试图片');
    const request = {
      source: { kind: 'bytes' as const, bytes: source },
      task: 'caption' as const,
      providerConfigId: 'provider-1',
      modelId: 'vision-1',
      promptRevision: 'caption-v1',
    };
    const cache = new AttachmentDerivationCache({ activeDataDir: dataDir, repo });

    const [first, concurrent] = await Promise.all([
      cache.getOrCreate(request, producer),
      cache.getOrCreate(request, producer),
    ]);
    expect(producer).toHaveBeenCalledTimes(1);
    expect(first.text).toBe('粉色测试图片');
    expect(concurrent.text).toBe('粉色测试图片');

    const restarted = new AttachmentDerivationCache({ activeDataDir: dataDir, repo });
    const disk = await restarted.getOrCreate(request, producer);
    expect(disk.cache).toBe('disk');
    expect(producer).toHaveBeenCalledTimes(1);
    expect(await stat(path.join(
      dataDir,
      'attachments',
      'vision-cache',
      disk.image.contentSha256.slice(0, 2),
      disk.image.contentSha256,
      'image.webp',
    ))).toMatchObject({ size: disk.image.bytes.byteLength });
  });

  it('忙碌时不清理，空闲后删除过期派生及无人引用的规范化图片', async () => {
    const cache = new AttachmentDerivationCache({ activeDataDir: dataDir, repo });
    await cache.getOrCreate({
      source: { kind: 'bytes', bytes: source },
      task: 'caption',
      providerConfigId: 'provider-1',
      modelId: 'vision-1',
      promptRevision: 'caption-v1',
    }, async () => '会过期的描述');

    database.sqlite.prepare(
      'UPDATE attachment_vision_derivations SET last_used_at = 1',
    ).run();
    database.sqlite.prepare(
      'UPDATE attachment_cached_images SET last_used_at = 1',
    ).run();

    let idle = false;
    const maintenance = new AttachmentCacheMaintenance({
      activeDataDir: dataDir,
      repo,
      isIdle: () => idle,
      ttlMs: 10,
      minIntervalMs: 0,
    });
    expect((await maintenance.sweepIfIdle(100)).ran).toBe(false);
    expect(repo.totalBytes()).toBeGreaterThan(0);

    idle = true;
    const report = await maintenance.sweepIfIdle(100);
    expect(report).toMatchObject({
      ran: true,
      deletedDerivations: 1,
      deletedImages: 1,
    });
    expect(repo.totalBytes()).toBe(0);

    const remainingFiles = database.sqlite.prepare(
      'SELECT COUNT(*) FROM attachment_cached_images',
    ).pluck().get();
    expect(remainingFiles).toBe(0);
  });

  it('规范化结果不保留输入 EXIF，并且同一输入得到稳定内容哈希', async () => {
    const withMetadata = new Uint8Array(await sharp(source)
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer());
    const cache = new AttachmentDerivationCache({ activeDataDir: dataDir, repo });
    const request = {
      source: { kind: 'bytes' as const, bytes: withMetadata },
      task: 'caption' as const,
      providerConfigId: 'provider-1',
      modelId: 'vision-1',
      promptRevision: 'caption-v1',
    };
    const first = await cache.getOrCreate(request, async () => '描述');
    const second = await cache.getOrCreate(request, async () => '不会调用');

    expect(second.image.contentSha256).toBe(first.image.contentSha256);
    const cachedImage = await readFile(path.join(
      dataDir,
      'attachments',
      'vision-cache',
      first.image.contentSha256.slice(0, 2),
      first.image.contentSha256,
      'image.webp',
    ));
    const metadata = await sharp(cachedImage).metadata();
    expect(metadata.orientation).toBeUndefined();
  });
});
