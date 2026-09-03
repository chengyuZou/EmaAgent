// 测试角色 Prompt 平铺装配、空 Prompt 硬门与数据库外部破坏的领域边界。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@ema-agent/storage';
import {
  CharacterStore,
  assertPersonaPrompt,
  buildCharacterPrompt,
  buildLive2dControlPrompt,
} from '../index.js';

describe('character prompt assembly', () => {
  let database: Database;
  let root: string;
  let store: CharacterStore;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    root = mkdtempSync(join(tmpdir(), 'ema-character-prompt-'));
    store = new CharacterStore(database, root);
    store.ensureSeed();
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('builds persona prompt with optional live2d control section', () => {
    const created = store.create({
      name: 'Blocks',
      personaPrompt: 'block-one',
    });
    const sections = buildCharacterPrompt(store.get(created.id)!);
    expect(sections).toEqual(['block-one']);
    expect(sections.every(s => typeof s === 'string')).toBe(true);
  });

  it('rejects a character whose persona is emptied directly in the database', () => {
    const created = store.create({
      name: 'Broken',
      personaPrompt: 'valid',
    });
    database.sqlite.prepare(
      'UPDATE characters SET persona_prompt = ? WHERE id = ?',
    ).run('   ', created.id);

    expect(() => buildCharacterPrompt(
      store.get(created.id)!,
    )).toThrow('人设提示词不能为空');
  });

  it('omits the control prompt when no vocabulary is present', () => {
    const created = store.create({
      name: 'NoVocab',
      personaPrompt: 'plain',
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

  it('普通情绪动作描写可以保存，Live2D 控制标签不能占用', () => {
    expect(() => store.create({
      name: 'NaturalLanguage',
      personaPrompt: '开心时语气轻快，生气时动作克制。',
    })).not.toThrow();

    for (const content of [
      '<emotion>happy</emotion>',
      '<MOTION>wave</MOTION>',
      '正文末尾出现未闭合标签 <emotion',
      '正文中出现 < / motion > 变体',
    ]) {
      expect(() => store.create({
        name: `Reserved-${content.length}`,
        personaPrompt: content,
      })).toThrow('不能包含 <emotion> 或 <motion>');
    }
  });

  it('assertPersonaPrompt 拒绝空与 Live2D 控制标签', () => {
    expect(() => assertPersonaPrompt('   ')).toThrow('不能为空');
    expect(() => assertPersonaPrompt('<emotion>happy</emotion>'))
      .toThrow('不能包含 <emotion> 或 <motion>');
    expect(() => assertPersonaPrompt('正常的人设')).not.toThrow();
  });
});
