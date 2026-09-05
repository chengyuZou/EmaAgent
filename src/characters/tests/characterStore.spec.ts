// 测试 Character 新身份、切换删除、明确舞台类型与文件名资源契约。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    store.ensureSeed();
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
    const first = await store.importIllustration('插图角色', { sourceFile: firstSource, expression: 'happy', isPrimary: true });
    const second = await store.importIllustration('插图角色', { sourceFile: secondSource, expression: 'happy' });

    expect(first.name).toBe('happy-a.png');
    expect(second.name).toBe('happy-b.png');
    expect(await store.inspectStagePresentation('插图角色')).toMatchObject({ status: 'blank' });
    await store.update('插图角色', { stageKind: 'illustration' });
    expect(await store.inspectStagePresentation('插图角色')).toMatchObject({
      status: 'illustration',
      resource: { name: 'happy-a.png' },
    });

    await store.deleteIllustration('插图角色', 'happy-a.png');
    expect(store.get('插图角色')?.illustrations.find(resource => resource.isPrimary)).toBeUndefined();
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
    fs.writeFileSync(path.join(source, 'wave.motion3.json'), '{}');
    fs.writeFileSync(path.join(source, 'runtime-config.json'), JSON.stringify({ authorField: 'preserved' }));

    const imported = await store.importLive2dModel('模型角色', { source, isPrimary: true });

    expect(imported.name).toBe('alice-model');
    expect(store.resolveLive2dModelDirectory('模型角色', 'alice-model')).toBe(
      path.join(root, 'characters', '模型角色', 'live2d', 'alice-model'),
    );
    await expect(store.readLive2dConfiguration('模型角色', 'alice-model')).resolves.toMatchObject({
      expressions: ['Smile'],
      motions: [{ group: 'Wave', index: 0 }],
    });

    const saved = await store.saveLive2dMappings('模型角色', 'alice-model', {
      emotionMap: { happy: { expression: 'Smile' } },
      motionMap: { wave: { group: 'Wave', index: 0 } },
    });
    expect(saved.runtimeConfig).toMatchObject({
      emotionMap: { happy: { expression: 'Smile' } },
      motionMap: { wave: { group: 'Wave', index: 0 } },
    });
    expect(JSON.parse(fs.readFileSync(
      path.join(root, 'characters', '模型角色', 'live2d', 'alice-model', 'runtime-config.json'),
      'utf8',
    ))).toMatchObject({ authorField: 'preserved' });
    await store.update('模型角色', { stageKind: 'live2d' });
    expect(characterStageVocabulary(store.inspectStagePresentation('模型角色'))).toEqual({
      emotions: ['happy'],
      motions: ['wave'],
    });
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
});

function pngBytes(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  ]);
}
