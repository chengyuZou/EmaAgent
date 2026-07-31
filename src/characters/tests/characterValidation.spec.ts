// 测试角色 Prompt 硬门、资源路径边界、健康降级与单角色资源操作串行。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { asCharacterVoiceReferenceId } from '@ema-agent/ids';
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

  it('参考音频数据库删除失败时从 trash 恢复原文件', async () => {
    const card = store.create({ name: 'Rollback', systemPrompt: 'valid' });
    const voiceDir = join(root, 'user', card.id, 'voiceRefs');
    mkdirSync(voiceDir, { recursive: true });
    const source = join(voiceDir, 'voice.mp3');
    writeFileSync(source, 'voice');
    const reference = store.addVoiceReference(card.id, {
      label: 'Voice',
      relativePath: 'voiceRefs/voice.mp3',
      promptText: 'hello',
      promptLang: 'en',
      mimeType: 'audio/mpeg',
    });
    database.sqlite.exec(`
      CREATE TRIGGER reject_voice_delete
      BEFORE DELETE ON character_voice_references
      BEGIN
        SELECT RAISE(ABORT, 'forced delete failure');
      END
    `);

    await expect(store.deleteManagedVoiceReference(card.id, reference.id))
      .rejects.toThrow('forced delete failure');
    expect(readFileSync(source, 'utf8')).toBe('voice');
    expect(store.get(card.id)?.voiceReferences).toHaveLength(1);
    expect(existsSync(join(root, 'user', '.trash'))).toBe(true);
  });

  it('参考音频目标路径已存在时不删除旧文件', async () => {
    const card = store.create({ name: 'Collision', systemPrompt: 'valid' });
    const voiceDir = join(root, 'user', card.id, 'voiceRefs');
    mkdirSync(voiceDir, { recursive: true });
    const source = join(voiceDir, 'voice.mp3');
    writeFileSync(source, 'original');

    await expect(store.publishVoiceReference(card.id, {
      id: asCharacterVoiceReferenceId('voice-collision'),
      label: 'Voice',
      relativePath: 'voiceRefs/voice.mp3',
      promptText: 'hello',
      promptLang: 'en',
      mimeType: 'audio/mpeg',
    }, new TextEncoder().encode('replacement'))).rejects.toThrow(
      'character resource destination already exists',
    );
    expect(readFileSync(source, 'utf8')).toBe('original');
    expect(store.get(card.id)?.voiceReferences).toHaveLength(0);
  });

  it('启动恢复按数据库事实源恢复中断删除并清理孤儿发布', () => {
    const card = store.create({ name: 'Recovery', systemPrompt: 'valid' });
    const voiceDir = join(root, 'user', card.id, 'voiceRefs');
    mkdirSync(voiceDir, { recursive: true });
    const source = join(voiceDir, 'kept.mp3');
    writeFileSync(source, 'kept');
    const reference = store.addVoiceReference(card.id, {
      label: 'Kept',
      relativePath: 'voiceRefs/kept.mp3',
      promptText: 'hello',
      promptLang: 'en',
      mimeType: 'audio/mpeg',
    });

    const trashId = '00000000-0000-4000-8000-000000000001';
    const trashDirectory = join(root, 'user', '.trash', trashId);
    mkdirSync(trashDirectory, { recursive: true });
    renameSync(source, join(trashDirectory, 'payload'));
    writeFileSync(join(trashDirectory, 'operation.json'), JSON.stringify({
      schemaVersion: 1,
      operationId: trashId,
      type: 'delete',
      characterId: card.id,
      resourceKind: 'voiceReference',
      resourceId: reference.id,
      relativePath: 'voiceRefs/kept.mp3',
    }));

    const orphanPath = join(voiceDir, 'orphan.mp3');
    writeFileSync(orphanPath, 'orphan');
    const importId = '00000000-0000-4000-8000-000000000002';
    const importDirectory = join(root, 'user', '.imports', importId);
    mkdirSync(importDirectory, { recursive: true });
    writeFileSync(join(importDirectory, 'operation.json'), JSON.stringify({
      schemaVersion: 1,
      operationId: importId,
      type: 'publish',
      characterId: card.id,
      resourceKind: 'voiceReference',
      resourceId: 'missing-resource',
      relativePath: 'voiceRefs/orphan.mp3',
    }));

    expect(store.recoverResourceFiles()).toEqual({
      restored: 1,
      removed: 2,
      failed: 0,
    });
    expect(readFileSync(source, 'utf8')).toBe('kept');
    expect(existsSync(orphanPath)).toBe(false);
    expect(existsSync(trashDirectory)).toBe(false);
    expect(existsSync(importDirectory)).toBe(false);
  });
});
