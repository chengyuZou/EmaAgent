import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '@ema-agent/storage';
import { buildCharacterPrompt, characterStageVocabulary } from '../characterPrompt.js';
import { EMA_CHARACTER_INPUT, EMA_CHARACTER_NAME } from '../seed/index.js';
import { CHARACTER_STICKER_PROMPT_MAX_CHARS } from '../stickers/limits.js';
import { CharacterStore } from '../store.js';

describe('CharacterStore', () => {
  let database: Database;
  let root: string;
  let store: CharacterStore;

  beforeEach(async () => {
    database = new Database({ memory: true, kind: 'profile' });
    await database.migrate();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-character-'));
    store = new CharacterStore(database, path.join(root, 'characters'));
    store.initializeBuiltinCharacters();
  });

  afterEach(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });


  it('表情包描述为空时不进入 Prompt, 保存后使用实际地址, 超限不修改已有数据', async () => {
    const source = path.join(root, '开心 (1).png');
    fs.writeFileSync(source, pngBytes());
    const item = await store.stickers.import(EMA_CHARACTER_NAME, source);
    expect(store.stickers.prompt(EMA_CHARACTER_NAME)).toBe('');
    expect(item.description).toBe('');

    await store.stickers.update(EMA_CHARACTER_NAME, item.name, {
      displayName: '开心',
      description: '挥手打招呼.',
    });
    const prompt = store.stickers.prompt(EMA_CHARACTER_NAME);
    expect(prompt).toContain('名称: 开心');
    expect(prompt).toContain('%281%29.png');
    expect(store.current().stickerPromptLength).toBe(prompt.length);
    expect(buildCharacterPrompt(store.current(), {
      status: 'blank', characterName: EMA_CHARACTER_NAME,
    }, prompt).at(-1)).toBe(prompt);

    await expect(store.stickers.update(EMA_CHARACTER_NAME, item.name, {
      displayName: '开心',
      description: 'a'.repeat(CHARACTER_STICKER_PROMPT_MAX_CHARS),
    })).rejects.toThrow('超过上限');
    expect(store.stickers.prompt(EMA_CHARACTER_NAME)).toBe(prompt);

    const exactDescription = 'a'.repeat(CHARACTER_STICKER_PROMPT_MAX_CHARS - prompt.length + '挥手打招呼.'.length);
    await store.stickers.update(EMA_CHARACTER_NAME, item.name, {
      displayName: '开心', description: exactDescription,
    });
    expect(store.stickers.prompt(EMA_CHARACTER_NAME).length).toBe(CHARACTER_STICKER_PROMPT_MAX_CHARS);
    await expect(store.stickers.update(EMA_CHARACTER_NAME, item.name, {
      displayName: '开心', description: exactDescription + 'a',
    })).rejects.toThrow('超过上限');

    const file = store.stickers.resolveFile(EMA_CHARACTER_NAME, item.name);
    await expect(store.stickers.import(EMA_CHARACTER_NAME, source)).rejects.toThrow();
    expect(fs.existsSync(file)).toBe(true);
    await store.stickers.delete(EMA_CHARACTER_NAME, item.name);
    expect(fs.existsSync(file)).toBe(false);
    expect(store.current().stickers).toEqual([]);
  });

  it('首次初始化保存完整的艾玛人设, 并将原文传入角色 Prompt', () => {
    const character = store.current();

    expect(character.name).toBe(EMA_CHARACTER_NAME);
    expect(character.personaPrompt).toBe(EMA_CHARACTER_INPUT.personaPrompt);
    expect(character.description).toBe(EMA_CHARACTER_INPUT.description);
    expect(buildCharacterPrompt(character, {
      status: 'blank',
      characterName: EMA_CHARACTER_NAME,
    })).toEqual([
      `当前角色: ${EMA_CHARACTER_NAME}`,
      EMA_CHARACTER_INPUT.personaPrompt,
    ]);
  });

  it('内置人设明确岛上人员和设施规则, 并区分不同周目的经历', () => {
    const prompt = EMA_CHARACTER_INPUT.personaPrompt;

    expect(prompt).toContain('岛上除了典狱长, 看守, 囚犯和剧情明确出现的相关角色外, 没有其他人类存在.');
    expect(prompt).toContain('有食堂不代表有食堂阿姨, 有图书室不代表有图书管理员, 有医务室也不代表有医护人员.');
    expect(prompt).toContain('过去的食堂在规定时间供餐, 采用自助取餐的方式.');
    expect(prompt).toContain('魔女杀手');
    expect(prompt).toContain('不同周目的事件与人物状态不能混成同一次经历.');
    expect(prompt).not.toMatch(/[，。；：！？（）【】「」『』“”‘’、…—]/u);
    expect(EMA_CHARACTER_INPUT.description).not.toMatch(/[，。；：！？（）【】「」『』“”‘’、…—]/u);
  });

  it('内置人设默认处于全部剧情结束后, 不把监禁与未和解状态延续到现在', () => {
    const prompt = EMA_CHARACTER_INPUT.personaPrompt;

    expect(prompt).toContain('默认时间线是全部剧情结束之后, 包括最终审判以及艾玛与希罗在告别时的和解.');
    expect(prompt).toContain('以下是回忆监禁时期时使用的背景, 不是结局后每天仍需执行的作息.');
    expect(prompt).toContain('两人重新选择继续相处');
    expect(prompt).toContain('结局后, 冷冻保存的少女们和看守也陆续从诅咒中苏醒.');
    expect(prompt).toContain('不据此断言结局后仍能随时施展魔法或再次魔女化.');
    expect(prompt).toContain('结尾仍有其他监狱岛和魔女因子持续扩散的消息');
    expect(prompt).toContain('此外称呼月代雪为"小雪".');
    expect(prompt).not.toContain('不意味着在所有时间点都已经知道真相');
    expect(EMA_CHARACTER_INPUT.description).toContain('全部剧情结束后');
  });

  it('再次初始化不会用内置人设覆盖用户已经编辑的角色卡', async () => {
    const personaPrompt = '我是用户编辑后的艾玛.';
    await store.update(EMA_CHARACTER_NAME, { personaPrompt });

    store.initializeBuiltinCharacters();

    expect(store.current().personaPrompt).toBe(personaPrompt);
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
    const first = await store.illustrations.import('插图角色', { sourceFile: firstSource, expression: 'happy' });
    const second = await store.illustrations.import('插图角色', { sourceFile: secondSource, expression: 'happy' });
    await store.illustrations.setPrimary('插图角色', first.name);

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

    await store.illustrations.delete('插图角色', 'happy-a.png');
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

    const resourceChanges: string[] = [];
    const presentationChanges: string[] = [];
    const stopResourceChanges = store.onResourcesChanged(character => {
      resourceChanges.push(character.name);
    });
    const stopPresentationChanges = store.onPresentationChanged(character => {
      presentationChanges.push(character.name);
    });
    const prepared = await store.live2dModels.prepareImport('模型角色', { source });

    expect(prepared).toMatchObject({
      name: 'alice-model',
      displayName: 'alice-model',
    });
    expect(store.get('模型角色')?.live2dModels).toEqual([]);
    expect(fs.existsSync(path.join(root, 'characters', '模型角色', 'live2d', 'alice-model'))).toBe(false);

    const preparedArchiveChunks: Buffer[] = [];
    for await (const chunk of store.live2dModels.streamPreparedArchive('模型角色', prepared.importId)) {
      preparedArchiveChunks.push(Buffer.from(chunk));
    }
    expect(Object.keys(unzipSync(Buffer.concat(preparedArchiveChunks)))).toEqual(expect.arrayContaining([
      'alice.model3.json',
      'alice.moc3',
      'textures/texture.png',
    ]));

    const imported = await store.live2dModels.commitImport(
      '模型角色',
      prepared.importId,
      pngBytes(),
    );
    expect(resourceChanges).toEqual(['模型角色']);
    expect(presentationChanges).toEqual([]);

    await store.update('模型角色', { stageKind: 'live2d' });
    resourceChanges.length = 0;
    presentationChanges.length = 0;
    await store.live2dModels.setPrimary('模型角色', imported.name);
    stopResourceChanges();
    stopPresentationChanges();

    expect(imported.name).toBe('alice-model');
    expect(resourceChanges).toEqual(['模型角色']);
    expect(presentationChanges).toEqual(['模型角色']);
    const archiveChunks: Buffer[] = [];
    for await (const chunk of store.live2dModels.streamArchive('模型角色', 'alice-model')) {
      archiveChunks.push(Buffer.from(chunk));
    }
    expect(Object.keys(unzipSync(Buffer.concat(archiveChunks)))).toEqual(expect.arrayContaining([
      'alice.model3.json',
      'alice.moc3',
      'textures/texture.png',
    ]));
    expect(store.live2dModels.resolveDirectory('模型角色', 'alice-model')).toBe(
      path.join(root, 'characters', '模型角色', 'live2d', 'alice-model'),
    );
    await expect(store.live2dModels.readConfiguration('模型角色', 'alice-model')).resolves.toMatchObject({
      expressions: [{ expression: 'Smile', file: 'smile.exp3.json' }],
      motions: [{ group: 'Wave', index: 0, file: 'wave.motion3.json' }],
      unregisteredExpressionFiles: ['orphan.exp3.json'],
      unregisteredMotionFiles: ['orphan.motion3.json'],
    });
    expect(imported).toMatchObject({ emotionMap: {}, motionMap: {} });

    const saved = await store.live2dModels.saveMappings('模型角色', 'alice-model', {
      emotionMap: {
        determined: { expression: 'Smile' },
        happy: { expression: 'Smile' },
      },
      motionMap: { happy: { group: 'Wave', index: 0 }, wave: { group: 'Wave', index: 0 } },
    });
    expect(saved.mappings).toEqual({
      emotionMap: {
        determined: { expression: 'Smile' },
        happy: { expression: 'Smile' },
      },
      motionMap: { happy: { group: 'Wave', index: 0 }, wave: { group: 'Wave', index: 0 } },
    });
    const row = database.sqlite.prepare(
      'SELECT emotion_map_json, motion_map_json FROM character_live2d_models WHERE character_name = ? AND name = ?',
    ).get('模型角色', 'alice-model') as { emotion_map_json: string; motion_map_json: string };
    expect(JSON.parse(row.emotion_map_json)).toEqual(saved.mappings.emotionMap);
    expect(JSON.parse(row.motion_map_json)).toEqual(saved.mappings.motionMap);
    await expect(store.live2dModels.reloadConfiguration('模型角色', 'alice-model')).resolves.toMatchObject({
      mappings: saved.mappings,
    });
    const exported = await store.live2dModels.export('模型角色', 'alice-model', root);
    expect(Object.keys(unzipSync(fs.readFileSync(exported))).sort()).toEqual([
      'alice.moc3',
      'alice.model3.json',
      'orphan.exp3.json',
      'orphan.motion3.json',
      'smile.exp3.json',
      'textures/texture.png',
      'wave.motion3.json',
    ]);
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
    await store.live2dModels.savePreview('模型角色', 'alice-model', pngBytes());
    stopPreviewChanges();
    stopPreviewPresentationChanges();
    const preview = path.join(root, 'characters', '模型角色', '.previews', 'alice-model.png');
    expect(fs.existsSync(preview)).toBe(true);
    expect(previewChanges).toEqual(['模型角色']);
    expect(previewPresentationChanges).toEqual([]);
    await store.live2dModels.delete('模型角色', 'alice-model');
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

    const prepared = await store.live2dModels.prepareImport('取消角色', { source });
    await store.live2dModels.cancelImport('取消角色', prepared.importId);

    expect(store.get('取消角色')?.live2dModels).toEqual([]);
    expect(fs.existsSync(path.join(root, 'characters', '.staging', prepared.importId))).toBe(false);
  });

  it('同一角色的同名导入串行，失败请求不会删除先成功的资源', async () => {
    store.create({ name: '并发角色', personaPrompt: '角色。' });
    const source = path.join(root, 'same.png');
    fs.writeFileSync(source, pngBytes());

    const results = await Promise.allSettled([
      store.illustrations.import('并发角色', { sourceFile: source }),
      store.illustrations.import('并发角色', { sourceFile: source }),
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
