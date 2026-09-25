// 测试 Character 新身份、切换删除、明确舞台类型与文件名资源契约。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '@ema-agent/storage';
import { characterStageVocabulary } from '../characterPrompt.js';
import { EMA_CHARACTER_NAME } from '../seed/index.js';
import { CharacterStore } from '../store.js';

describe('CharacterStore', () => {
  let database: Database;
  let root: string;
  let store: CharacterStore;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-character-'));
    store = new CharacterStore(database, path.join(root, 'characters'));
    store.initializeBuiltinCharacters();
  });

  afterEach(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('以不可变 name 作为数据库和目录身份，displayName 只负责展示', async () => {
    const created = store.create({
      name: '爱丽丝',
      displayName: 'Alice',
      personaPrompt: '你是爱丽丝。',
    });

    expect(created).toMatchObject({ name: '爱丽丝', displayName: 'Alice', stageKind: 'blank' });
    expect(fs.existsSync(path.join(root, 'characters', '爱丽丝'))).toBe(true);
    expect(await store.update('爱丽丝', { displayName: '小爱' })).toMatchObject({ name: '爱丽丝', displayName: '小爱' });
    const summary = store.listSummaries().find(item => item.name === '爱丽丝');
    expect(summary).toMatchObject({
      name: '爱丽丝',
      displayName: '小爱',
      live2dCount: 0,
      illustrationCount: 0,
      voiceSampleCount: 0,
      coverResourceName: null,
    });
    expect(summary).not.toHaveProperty('personaPrompt');
    expect(summary).not.toHaveProperty('voiceSamples');
  });

  it('Store 只删除指定角色，不裁决或切换替代角色', async () => {
    store.create({ name: '甲', personaPrompt: '甲。' });
    store.create({ name: '乙', personaPrompt: '乙。' });
    store.activate('甲');

    await store.deleteCharacter('乙');

    expect(store.get('乙')).toBeUndefined();
    expect(store.current().name).toBe('甲');
  });

  it('删除当前角色时在同一 SQL 事务内激活替代角色，并拒绝删除最后一个角色', async () => {
    store.create({ name: '甲', personaPrompt: '甲。' });
    store.create({ name: '乙', personaPrompt: '乙。' });
    store.activate('甲');

    await expect(store.deleteCharacter('甲', '乙')).resolves.toBe('deleted');
    expect(store.current().name).toBe('乙');
    await expect(store.deleteCharacter('乙', EMA_CHARACTER_NAME)).resolves.toBe('deleted');
    fs.mkdirSync(path.join(root, 'characters', EMA_CHARACTER_NAME), { recursive: true });
    await expect(store.deleteCharacter(EMA_CHARACTER_NAME)).resolves.toBe('last_character');
    expect(store.current().name).toBe(EMA_CHARACTER_NAME);
    expect(fs.existsSync(path.join(root, 'characters', EMA_CHARACTER_NAME))).toBe(true);
  });

  it('插图以完整文件名为 name，删除主要资源不会自动提升其他资源', async () => {
    store.create({ name: '插图角色', personaPrompt: '角色。' });
    const firstSource = path.join(root, 'happy-a.png');
    const secondSource = path.join(root, 'happy-b.png');
    fs.writeFileSync(firstSource, pngBytes());
    fs.writeFileSync(secondSource, pngBytes());
    const first = await store.importIllustration('插图角色', { sourceFile: firstSource, expression: 'happy' });
    const second = await store.importIllustration('插图角色', { sourceFile: secondSource, expression: 'happy' });
    await store.setPrimaryIllustration('插图角色', first.name);

    expect(store.listSummaries().find(item => item.name === '插图角色')).toMatchObject({
      illustrationCount: 2,
      coverResourceName: null,
    });

    expect(first.name).toBe('happy-a.png');
    expect(second.name).toBe('happy-b.png');
    expect(await store.inspectStagePresentation('插图角色')).toMatchObject({ status: 'blank' });
    await store.update('插图角色', { stageKind: 'illustration' });
    expect(store.listSummaries().find(item => item.name === '插图角色')?.coverResourceName).toBe(first.name);
    expect(await store.inspectStagePresentation('插图角色')).toMatchObject({
      status: 'illustration',
      resource: { name: 'happy-a.png' },
    });

    await store.deleteIllustration('插图角色', 'happy-a.png');
    expect(store.get('插图角色')?.illustrations.find(resource => resource.isPrimary)).toBeUndefined();
    expect(store.listSummaries().find(item => item.name === '插图角色')?.coverResourceName).toBe(second.name);
    expect(await store.inspectStagePresentation('插图角色')).toMatchObject({
      status: 'unavailable',
      reason: 'primary_resource_missing',
    });
  });

  it('Live2D 可从文件夹导入，并以文件夹名称作为 name', async () => {
    store.create({ name: '模型角色', personaPrompt: '角色。' });
    const source = path.join(root, 'alice-model');
    fs.mkdirSync(path.join(source, 'textures'), { recursive: true });
    fs.writeFileSync(path.join(source, 'alice.model3.json'), JSON.stringify({
      Version: 3,
      FileReferences: {
        Moc: 'alice.moc3',
        Textures: ['textures/texture.png'],
        Expressions: [{ Name: 'Smile', File: 'smile.exp3.json' }],
        Motions: { Wave: [{ File: 'wave.motion3.json' }] },
      },
    }));
    fs.writeFileSync(path.join(source, 'alice.moc3'), Buffer.from([1]));
    fs.writeFileSync(path.join(source, 'textures', 'texture.png'), pngBytes());
    fs.writeFileSync(path.join(source, 'smile.exp3.json'), '{}');
    fs.writeFileSync(path.join(source, 'orphan.exp3.json'), '{}');
    fs.writeFileSync(path.join(source, 'wave.motion3.json'), '{}');
    fs.writeFileSync(path.join(source, 'orphan.motion3.json'), '{}');
    const runtimeConfig = {
      emotionMap: {
        neutral: {},
        determined: { expression: 'Smile' },
      },
      motionMap: { disabled: {} },
    };
    fs.writeFileSync(path.join(source, 'runtime-config.json'), JSON.stringify(runtimeConfig));

    const resourceChanges: string[] = [];
    const presentationChanges: string[] = [];
    const stopResourceChanges = store.onResourcesChanged(character => {
      resourceChanges.push(character.name);
    });
    const stopPresentationChanges = store.onPresentationChanged(character => {
      presentationChanges.push(character.name);
    });
    const prepared = await store.prepareLive2dImport('模型角色', { source });

    expect(prepared).toMatchObject({
      name: 'alice-model',
      displayName: 'alice-model',
    });
    expect(store.get('模型角色')?.live2dModels).toEqual([]);
    expect(fs.existsSync(path.join(root, 'characters', '模型角色', 'live2d', 'alice-model'))).toBe(false);

    const preparedArchiveChunks: Buffer[] = [];
    for await (const chunk of store.streamPreparedLive2dArchive('模型角色', prepared.importId)) {
      preparedArchiveChunks.push(Buffer.from(chunk));
    }
    expect(Object.keys(unzipSync(Buffer.concat(preparedArchiveChunks)))).toEqual(expect.arrayContaining([
      'alice.model3.json',
      'alice.moc3',
      'textures/texture.png',
    ]));

    const imported = await store.commitLive2dImport(
      '模型角色',
      prepared.importId,
      pngBytes(),
    );
    expect(resourceChanges).toEqual(['模型角色']);
    expect(presentationChanges).toEqual([]);

    await store.update('模型角色', { stageKind: 'live2d' });
    resourceChanges.length = 0;
    presentationChanges.length = 0;
    await store.setPrimaryLive2dModel('模型角色', imported.name);
    stopResourceChanges();
    stopPresentationChanges();

    expect(imported.name).toBe('alice-model');
    expect(resourceChanges).toEqual(['模型角色']);
    expect(presentationChanges).toEqual(['模型角色']);
    const archiveChunks: Buffer[] = [];
    for await (const chunk of store.streamLive2dArchive('模型角色', 'alice-model')) {
      archiveChunks.push(Buffer.from(chunk));
    }
    expect(Object.keys(unzipSync(Buffer.concat(archiveChunks)))).toEqual(expect.arrayContaining([
      'alice.model3.json',
      'alice.moc3',
      'textures/texture.png',
    ]));
    expect(store.resolveLive2dModelDirectory('模型角色', 'alice-model')).toBe(
      path.join(root, 'characters', '模型角色', 'live2d', 'alice-model'),
    );
    await expect(store.readLive2dConfiguration('模型角色', 'alice-model')).resolves.toMatchObject({
      expressions: [{ expression: 'Smile', file: 'smile.exp3.json' }],
      motions: [{ group: 'Wave', index: 0, file: 'wave.motion3.json' }],
      unregisteredExpressionFiles: ['orphan.exp3.json'],
      unregisteredMotionFiles: ['orphan.motion3.json'],
    });
    const runtimeConfigPath = path.join(
      root,
      'characters',
      '模型角色',
      'live2d',
      'alice-model',
      'runtime-config.json',
    );
    expect(JSON.parse(fs.readFileSync(runtimeConfigPath, 'utf8'))).toEqual(runtimeConfig);

    const saved = await store.saveLive2dMappings('模型角色', 'alice-model', {
      emotionMap: {
        determined: { expression: 'Smile' },
        happy: { expression: 'Smile' },
      },
      motionMap: { happy: { group: 'Wave', index: 0 }, wave: { group: 'Wave', index: 0 } },
    });
    expect(saved.runtimeConfig).toMatchObject({
      emotionMap: {
        determined: { expression: 'Smile' },
        happy: { expression: 'Smile' },
      },
      motionMap: { happy: { group: 'Wave', index: 0 }, wave: { group: 'Wave', index: 0 } },
    });
    expect(JSON.parse(fs.readFileSync(runtimeConfigPath, 'utf8'))).toEqual({
      emotionMap: {
        neutral: {},
        determined: { expression: 'Smile' },
        happy: { expression: 'Smile' },
      },
      motionMap: {
        disabled: {},
        happy: { group: 'Wave', index: 0 },
        wave: { group: 'Wave', index: 0 },
      },
    });
    expect(characterStageVocabulary(store.inspectStagePresentation('模型角色'))).toEqual({
      emotions: ['determined', 'happy'],
      motions: ['happy', 'wave'],
    });

    const previewChanges: string[] = [];
    const previewPresentationChanges: string[] = [];
    const stopPreviewChanges = store.onResourcesChanged(character => {
      previewChanges.push(character.name);
    });
    const stopPreviewPresentationChanges = store.onPresentationChanged(character => {
      previewPresentationChanges.push(character.name);
    });
    await store.saveLive2dPreview('模型角色', 'alice-model', pngBytes());
    stopPreviewChanges();
    stopPreviewPresentationChanges();
    const preview = path.join(root, 'characters', '模型角色', '.previews', 'alice-model.png');
    expect(fs.existsSync(preview)).toBe(true);
    expect(previewChanges).toEqual(['模型角色']);
    expect(previewPresentationChanges).toEqual([]);
    await store.deleteLive2dModel('模型角色', 'alice-model');
    expect(fs.existsSync(preview)).toBe(false);
  });

  it('取消 Live2D 暂存导入后不会留下模型或封面', async () => {
    store.create({ name: '取消角色', personaPrompt: '角色。' });
    const source = path.join(root, 'cancel-model');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'cancel.model3.json'), JSON.stringify({
      Version: 3,
      FileReferences: {
        Moc: 'cancel.moc3',
        Textures: ['cancel.png'],
      },
    }));
    fs.writeFileSync(path.join(source, 'cancel.moc3'), Buffer.from([1]));
    fs.writeFileSync(path.join(source, 'cancel.png'), pngBytes());

    const prepared = await store.prepareLive2dImport('取消角色', { source });
    await store.cancelLive2dImport('取消角色', prepared.importId);

    expect(store.get('取消角色')?.live2dModels).toEqual([]);
    expect(fs.existsSync(path.join(root, 'characters', '.staging', prepared.importId))).toBe(false);
  });

  it('同一角色的同名导入串行，失败请求不会删除先成功的资源', async () => {
    store.create({ name: '并发角色', personaPrompt: '角色。' });
    const source = path.join(root, 'same.png');
    fs.writeFileSync(source, pngBytes());

    const results = await Promise.allSettled([
      store.importIllustration('并发角色', { sourceFile: source }),
      store.importIllustration('并发角色', { sourceFile: source }),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(store.get('并发角色')?.illustrations).toHaveLength(1);
    expect(fs.existsSync(path.join(root, 'characters', '并发角色', 'illustration', 'same.png'))).toBe(true);
  });

  it('启动时清理上次中断留下的 staging 操作目录', () => {
    const charactersRoot = path.join(root, 'characters');
    const stale = path.join(charactersRoot, '.staging', 'stale-operation');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'partial'), 'partial');

    new CharacterStore(database, charactersRoot);

    expect(fs.existsSync(path.join(charactersRoot, '.staging'))).toBe(false);
  });

  it('启动时为缺少容量的内置 Live2D 数据回填模型目录总字节数', () => {
    const directory = path.join(root, 'characters', EMA_CHARACTER_NAME, 'live2d', 'ema');
    fs.mkdirSync(path.join(directory, 'textures'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'ema.model3.json'), '1234');
    fs.writeFileSync(path.join(directory, 'textures', 'texture.png'), '123456');

    const reopened = new CharacterStore(database, path.join(root, 'characters'));

    expect(reopened.get(EMA_CHARACTER_NAME)?.live2dModels[0]?.byteSize).toBe(10);
  });
});

function pngBytes(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  ]);
}
