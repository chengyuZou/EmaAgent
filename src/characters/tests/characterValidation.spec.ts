// 测试角色 Prompt 平铺装配、空 Prompt 硬门与数据库外部破坏的领域边界。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database, SettingsRepo } from '@ema-agent/storage';
import { SettingsStore } from '@ema-agent/settings';
import {
  CharacterStore,
  CHARACTER_SETTING_DEFINITIONS,
  assertCharacterPromptBlocks,
  buildCharacterPrompt,
  buildLive2dControlPrompt,
  characterPromptLimitsGroup,
  characterPromptMaxTotalCharsSetting,
  readCharacterSettings,
  validateCharacterPromptLimits,
} from '../index.js';

describe('character prompt assembly', () => {
  let database: Database;
  let root: string;
  let store: CharacterStore;
  let settings: SettingsStore;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    root = mkdtempSync(join(tmpdir(), 'ema-character-prompt-'));
    settings = new SettingsStore(new SettingsRepo(database.sqlite), {
      definitions: CHARACTER_SETTING_DEFINITIONS,
      groups: [characterPromptLimitsGroup],
    });
    store = new CharacterStore(database, root, settings);
    store.ensureSeed();
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('builds a flat array of enabled blocks ordered by sort order', () => {
    const created = store.create({
      name: 'Blocks',
      promptBlocks: [
        { name: 'second', content: 'block-two' },
        { name: 'first', content: 'block-one' },
        { name: 'off', content: 'disabled-content', enabled: false },
      ],
    });
    const sections = buildCharacterPrompt(store.get(created.id)!);
    expect(sections).toEqual(['block-two', 'block-one']);
    expect(sections.every(s => typeof s === 'string')).toBe(true);
  });

  it('rejects a character whose blocks are emptied directly in the database', () => {
    const created = store.create({
      name: 'Broken',
      promptBlocks: [{ name: 'x', content: 'valid' }],
    });
    database.sqlite.prepare(
      'UPDATE character_prompt_blocks SET content = ? WHERE character_id = ?',
    ).run('   ', created.id);

    expect(() => buildCharacterPrompt(
      store.get(created.id)!,
    )).toThrow('至少需要一个启用的 Prompt Block');
  });

  it('omits the control prompt when no vocabulary is present', () => {
    const created = store.create({
      name: 'NoVocab',
      promptBlocks: [{ name: 'x', content: 'plain' }],
    });
    const sections = buildCharacterPrompt(store.get(created.id)!);
    expect(sections).toEqual(['plain']);
    expect(buildLive2dControlPrompt(store.get(created.id)!)).toBe('');
  });

  it('appends the control prompt after blocks when vocabulary exists', () => {
    // Seed Ema's primary live2d row gets vocabulary written by the store on seed.
    const ema = store.get('ema')!;
    const live2d = ema.live2dModels[0]!;
    if (live2d.emotionVocabulary.length === 0 && live2d.motionVocabulary.length === 0) {
      // Seed without a runtime-config on disk has empty vocabularies.
      expect(buildLive2dControlPrompt(ema)).toBe('');
      return;
    }
    const sections = buildCharacterPrompt(ema);
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(sections[0]).toContain('樱羽艾玛');
    expect(sections.at(-1)).toContain('角色表达控制协议');
  });

  it('拒绝会让单块上限大于总上限的 Settings 更新', () => {
    expect(() => settings.set(characterPromptMaxTotalCharsSetting, 1_000))
      .toThrow('设置组');
  });

  it('用真实角色数据评估更小的 Prompt 上限', () => {
    const created = store.create({
      name: 'TooLong',
      promptBlocks: [{ name: 'base', content: '123456' }],
    });
    const issues = validateCharacterPromptLimits({
      maxBlocks: 32,
      maxBlockNameChars: 80,
      maxBlockChars: 5,
      maxTotalChars: 64_000,
    }, [created]);
    expect(issues).toEqual([expect.objectContaining({
      characterId: created.id,
      blockId: created.promptBlocks[0]!.id,
    })]);
  });

  it('普通情绪动作描写可以保存，Live2D 控制标签不能占用', () => {
    expect(() => store.create({
      name: 'NaturalLanguage',
      promptBlocks: [{ name: '语气', content: '开心时语气轻快，生气时动作克制。' }],
    })).not.toThrow();

    for (const content of [
      '<emotion>happy</emotion>',
      '<MOTION>wave</MOTION>',
      '正文末尾出现未闭合标签 <emotion',
      '正文中出现 < / motion > 变体',
    ]) {
      expect(() => store.create({
        name: `Reserved-${content.length}`,
        promptBlocks: [{ name: '非法控制标签', content }],
      })).toThrow('不能包含 <emotion> 或 <motion>');
    }
  });

  it('数量、名称、单块和总字符上限由同一领域校验负责', () => {
    const block = (id: string, name: string, content: string) => ({
      id,
      characterId: 'limits',
      name,
      content,
      enabled: true,
      sortOrder: Number(id),
      createdAt: 0,
      updatedAt: 0,
    });
    const limits = {
      maxBlocks: 1,
      maxBlockNameChars: 4,
      maxBlockChars: 5,
      maxTotalChars: 5,
    };

    expect(() => assertCharacterPromptBlocks([
      block('0', 'a', '123'),
      block('1', 'b', '456'),
    ], limits)).toThrow('数量超过上限');
    expect(() => assertCharacterPromptBlocks([
      block('0', '12345', '123'),
    ], limits)).toThrow('名称超过');
    expect(() => assertCharacterPromptBlocks([
      block('0', 'a', '123456'),
    ], limits)).toThrow('单个 Prompt Block 超过');
    expect(() => assertCharacterPromptBlocks([
      block('0', 'a', '123'),
      block('1', 'b', '456'),
    ], { ...limits, maxBlocks: 2, maxBlockChars: 5 })).toThrow('总字符数超过');
  });
});
