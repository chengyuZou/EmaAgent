// 测试 LocalHost 先建角色再补表现资源，并恢复全局角色和初始 Emotion 词表。

import { afterEach, describe, expect, it } from 'vitest';
import { CharacterCardStore, EMA_CARD_ID } from '@ema-agent/characters';
import { asSessionId, asTurnId } from '@ema-agent/ids';
import { Database } from '@ema-agent/storage';
import { createCharacterRuntime } from '../src/wiring/createCharacterRuntime.js';

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe('createCharacterRuntime', () => {
  it('角色卡和内置 Live2D 资源由同一角色种子幂等补齐', () => {
    const profileDb = openProfileDatabase();

    const { card } = createCharacterRuntime(profileDb);

    expect(card.current().id).toBe(EMA_CARD_ID);
    expect(
      profileDb.sqlite
        .prepare('SELECT id FROM character_live2d_variants WHERE character_card_id = ?')
        .get(EMA_CARD_ID),
    ).toEqual({ id: 'ema:ema' });
  });

  it('重复构造保持内置模型和角色卡各一条', () => {
    const profileDb = openProfileDatabase();

    createCharacterRuntime(profileDb);
    createCharacterRuntime(profileDb);

    const live2dCount = profileDb.sqlite
      .prepare('SELECT COUNT(*) AS count FROM character_live2d_variants WHERE character_card_id = ?')
      .get(EMA_CARD_ID) as { count: number };
    const cardCount = profileDb.sqlite
      .prepare('SELECT COUNT(*) AS count FROM character_cards WHERE id = ?')
      .get(EMA_CARD_ID) as { count: number };

    expect(live2dCount.count).toBe(1);
    expect(cardCount.count).toBe(1);
  });

  it('没有激活角色时自动激活 Ema', () => {
    const profileDb = openProfileDatabase();

    const { card } = createCharacterRuntime(profileDb);

    expect(card.current()).toMatchObject({
      id: EMA_CARD_ID,
      isActive: true,
      isBuiltin: true,
    });
  });

  it('Emotion 初始词表来自构造时的当前全局角色', () => {
    const profileDb = openProfileDatabase();
    const initial = createCharacterRuntime(profileDb);
    const custom = initial.card.create({
      name: '测试角色',
      systemPrompt: '测试角色提示词',
      emotionVocabulary: ['focused'],
    });
    initial.card.activate(custom.id);

    const { emotion } = createCharacterRuntime(profileDb);
    const sessionId = asSessionId('session-character-runtime');
    const turnId = asTurnId('turn-character-runtime');
    emotion.beginTurn(sessionId);

    const focused = emotion.processChunk(
      '<|ACT:emotion:focused|>',
      turnId,
      sessionId,
    );
    const unknown = emotion.processChunk(
      '<|ACT:emotion:happy|>',
      turnId,
      sessionId,
    );

    expect(focused.events).toHaveLength(1);
    expect(focused.events[0]).toMatchObject({
      type: 'emotion_changed',
      state: { primary: 'focused' },
    });
    expect(unknown.events).toEqual([]);
  });

  it('数据库不变量损坏时向上抛错，不带病发布 ready', () => {
    const profileDb = openProfileDatabase();
    profileDb.sqlite.exec('DROP TABLE character_cards');

    expect(() => createCharacterRuntime(profileDb)).toThrow();
  });
});

function openProfileDatabase(): Database {
  const database = new Database({ memory: true, kind: 'profile' });
  database.migrate();
  databases.push(database);
  return database;
}
