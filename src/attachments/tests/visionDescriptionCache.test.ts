// 测试 Vision 描述缓存：内存/磁盘两层命中、同键并发去重、空描述拒绝与空闲维护。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asSessionId, asTurnId } from '@ema-agent/ids';
import {
  AttachmentRepo,
  AttachmentVisionDescriptionsRepo,
  Database,
} from '@ema-agent/storage';
import { AttachmentStore } from '../attachmentStore.js';
import { AttachmentCacheMaintenance } from '../cacheMaintenance.js';
import { VisionDescriptionCache } from '../visionDescriptionCache.js';
import type { ImageAttachment } from '../types.js';

const sessionId = asSessionId('session-cache');
const turnId = asTurnId('turn-cache');

let database: Database;
let dataDir: string;
let repo: AttachmentVisionDescriptionsRepo;
let image: ImageAttachment;
const temporary: string[] = [];

const identity = {
  providerConfigId: 'provider-1',
  modelId: 'vision-1',
  instructionRevision: 'caption-v1',
};

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ema-att-cache-'));
  temporary.push(dataDir);
  database = new Database({ memory: true, kind: 'data' });
  database.migrate();
  database.sqlite.prepare(`
    INSERT INTO sessions (id, title, pinned, last_activity_at, created_at, updated_at)
    VALUES (?, 's', 0, 1, 1, 1)
  `).run(sessionId);
  database.sqlite.prepare(`
    INSERT INTO turns (id, session_id, trigger_type, execution_profile, narrative_policy,
      status, user_input, started_at)
    VALUES (?, ?, 'userMessage', 'chat', 'off', 'completed', '', 1)
  `).run(turnId, sessionId);

  const source = path.join(dataDir, 'source.png');
  writeFileSync(source, Buffer.from([1, 2, 3]));
  const store = new AttachmentStore({ repo: new AttachmentRepo(database.sqlite), dataDir });
  const [created] = await store.addAll([{ sourcePath: source }], turnId, sessionId);
  if (created?.kind !== 'image') throw new Error('fixture must be an image');
  image = created;
  repo = new AttachmentVisionDescriptionsRepo(database.sqlite);
});

afterEach(() => {
  database.close();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('VisionDescriptionCache', () => {
  it('并发同键只生产一次；重启实例后从 SQLite 复用', async () => {
    const cache = new VisionDescriptionCache(repo);
    const producer = vi.fn(async () => '一只粉色的猫');

    const [first, concurrent] = await Promise.all([
      cache.getOrCreate(image, identity, new AbortController().signal, producer),
      cache.getOrCreate(image, identity, new AbortController().signal, producer),
    ]);
    expect(first).toBe('一只粉色的猫');
    expect(concurrent).toBe('一只粉色的猫');
    expect(producer).toHaveBeenCalledTimes(1);

    const restarted = new VisionDescriptionCache(repo);
    const disk = await restarted.getOrCreate(
      image, identity, new AbortController().signal, producer,
    );
    expect(disk).toBe('一只粉色的猫');
    expect(producer).toHaveBeenCalledTimes(1);
  });

  it('指令版本或模型身份变化后重新生产', async () => {
    const cache = new VisionDescriptionCache(repo);
    const producer = vi.fn(async () => 'v1 描述');
    await cache.getOrCreate(image, identity, new AbortController().signal, producer);

    const v2 = await cache.getOrCreate(
      image,
      { ...identity, instructionRevision: 'caption-v2' },
      new AbortController().signal,
      async () => 'v2 描述',
    );
    expect(v2).toBe('v2 描述');
  });

  it('空描述拒绝入缓存', async () => {
    const cache = new VisionDescriptionCache(repo);
    await expect(cache.getOrCreate(
      image, identity, new AbortController().signal, async () => '   ',
    )).rejects.toThrow('Vision');
    expect(repo.totalBytes()).toBe(0);
  });
});

describe('AttachmentCacheMaintenance', () => {
  it('不空闲不清理；空闲时按 TTL 删除过期描述', async () => {
    const cache = new VisionDescriptionCache(repo);
    await cache.getOrCreate(image, identity, new AbortController().signal, async () => '描述');

    let idle = false;
    const maintenance = new AttachmentCacheMaintenance({
      repo,
      isIdle: () => idle,
      maxBytesForSweep: () => 1024 * 1024,
    });
    expect((await maintenance.sweepIfIdle()).ran).toBe(false);

    database.sqlite.prepare(
      'UPDATE attachment_vision_descriptions SET last_accessed_at = 1',
    ).run();
    idle = true;
    const report = await maintenance.sweepIfIdle();
    expect(report.ran).toBe(true);
    expect(report.deletedDescriptions).toBe(1);
    expect(repo.totalBytes()).toBe(0);
  });

  it('超过预算时从最久未访问开始驱逐', async () => {
    const cache = new VisionDescriptionCache(repo);
    await cache.getOrCreate(image, identity, new AbortController().signal, async () => '旧描述');
    await cache.getOrCreate(
      image,
      { ...identity, instructionRevision: 'caption-v2' },
      new AbortController().signal,
      async () => '新描述',
    );
    database.sqlite.prepare(
      'UPDATE attachment_vision_descriptions SET last_accessed_at = ? WHERE instruction_revision = ?',
    ).run(Date.now() - 1_000, 'caption-v1');
    database.sqlite.prepare(
      'UPDATE attachment_vision_descriptions SET last_accessed_at = ? WHERE instruction_revision = ?',
    ).run(Date.now(), 'caption-v2');

    const total = repo.totalBytes();
    const maintenance = new AttachmentCacheMaintenance({
      repo,
      isIdle: () => true,
      // 预算设为低于总量 => 驱逐最旧的一条
      maxBytesForSweep: () => total - 1,
    });
    const report = await maintenance.sweepIfIdle();
    expect(report.ran).toBe(true);
    expect(report.deletedDescriptions).toBe(1);
    expect(repo.find({
      attachmentId: image.id,
      providerConfigId: identity.providerConfigId,
      modelId: identity.modelId,
      instructionRevision: 'caption-v1',
    })).toBeUndefined();
    expect(repo.find({
      attachmentId: image.id,
      providerConfigId: identity.providerConfigId,
      modelId: identity.modelId,
      instructionRevision: 'caption-v2',
    })).toBeDefined();
  });
});
