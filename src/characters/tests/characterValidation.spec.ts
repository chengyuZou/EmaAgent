// 测试角色 Prompt 硬门、资源路径边界、健康降级与单角色资源操作串行。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Database } from '@ema-agent/storage';
import { CharacterCardStore, buildCharacterPromptSections } from '../index.js';

describe('character validation', () => {
  let database: Database;
  let root: string;
  let store: CharacterCardStore;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    root = mkdtempSync(join(tmpdir(), 'ema-character-validation-'));
    store = new CharacterCardStore({
      db: database,
      resourceRoots: {
        builtinCardsRoot: join(root, 'builtin'),
        userCardsRoot: join(root, 'user'),
      },
    });
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('Prompt 装配再次拒绝数据库中被外部写空的角色', () => {
    const card = store.create({ name: 'Broken', systemPrompt: 'valid' });
    database.sqlite.prepare(
      'UPDATE character_cards SET system_prompt = ? WHERE id = ?',
    ).run(' ', card.id);

    expect(() => buildCharacterPromptSections(store.get(card.id)!))
      .toThrow('character prompt is empty');
  });

  it('拒绝绝对路径、反斜杠和目录穿越', () => {
    const card = store.create({ name: 'Paths', systemPrompt: 'valid' });
    for (const relativePath of [
      '../outside.mp3',
      'voiceRefs/../../outside.mp3',
      'voiceRefs\\outside.mp3',
      'voiceRefs/NUL.mp3',
      'voiceRefs/audio.mp3:secret',
      'voiceRefs/trailing. ',
      '/etc/passwd',
      'C:\\Windows\\system.ini',
    ]) {
      expect(() => store.resolveResourcePath(
        card.id,
        relativePath,
        'voiceReference',
      )).toThrow('invalid character resource path');
    }
  });

  it('Live2D 缺失时降级到可用立绘，并以实际图片元数据深检', async () => {
    const card = store.create({ name: 'Portrait', systemPrompt: 'valid' });
    const portraitDir = join(root, 'user', card.id, 'portraits');
    mkdirSync(portraitDir, { recursive: true });
    const portraitPath = join(portraitDir, 'main.png');
    await sharp({
      create: {
        width: 64,
        height: 96,
        channels: 4,
        background: '#ffffff',
      },
    }).png().toFile(portraitPath);

    const portraitStat = await stat(portraitPath);
    store.addPortrait(card.id, {
      label: 'Main',
      relativePath: 'portraits/main.png',
      isPrimary: true,
      mimeType: 'image/png',
      byteSize: portraitStat.size,
      width: 64,
      height: 96,
    });

    const health = await store.inspectHealth(card.id, true);
    expect(health).toMatchObject({
      executionAvailable: true,
      presentation: 'portrait',
      voiceReferenceAvailable: false,
      status: 'degraded',
    });
    expect(health.issues.map((issue) => issue.code)).toContain('live2d_unavailable');
    expect(health.issues.map((issue) => issue.code))
      .not.toContain('portrait_metadata_mismatch');
  });

  it('主 Live2D 缺失时继续选择下一个可用资源，而不是直接降级到立绘', async () => {
    const card = store.create({ name: 'Fallback', systemPrompt: 'valid' });
    const live2dDir = join(root, 'user', card.id, 'live2d');
    mkdirSync(live2dDir, { recursive: true });
    writeFileSync(join(live2dDir, 'secondary.model3.json'), '{}');

    const missing = store.addLive2dVariant(card.id, {
      label: 'Missing primary',
      format: 'live2d',
      entryPath: 'live2d/missing.model3.json',
      position: 0,
      isPrimary: true,
    });
    const secondary = store.addLive2dVariant(card.id, {
      label: 'Secondary',
      format: 'live2d',
      entryPath: 'live2d/secondary.model3.json',
      position: 1,
    });

    const health = await store.inspectHealth(card.id);
    expect(health.presentation).toBe('live2d');
    expect(health.selectedLive2dVariantId).toBe(secondary.id);
    expect(health.presentationCandidates).toEqual([
      { kind: 'live2d', resourceId: secondary.id },
    ]);
    expect(health.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'resource_missing',
        resourceId: missing.id,
      }),
    ]));
  });

  it('同一角色资源操作严格串行，不同阶段可被观察', async () => {
    const card = store.create({ name: 'Queue', systemPrompt: 'valid' });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = store.runResourceOperation(
      card.id,
      'resourceImport',
      async ({ setStage }) => {
        setStage('staging');
        order.push('first:start');
        await firstGate;
        order.push('first:end');
      },
    );
    const second = store.runResourceOperation(
      card.id,
      'resourceDelete',
      async () => {
        order.push('second:start');
      },
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(store.inspectResourceOperation(card.id)?.stage).toBe('staging');
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
    expect(store.inspectResourceOperation(card.id)?.stage).toBe('completed');
  });
});
