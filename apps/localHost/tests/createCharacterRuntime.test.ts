// 测试 LocalHost 按外键顺序补角色种子、恢复全局角色并冻结初始 Emotion 词表。

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
  it('先补 Live2D 模型，再写入带外键的内置角色卡', () => {
    const profileDb = openProfileDatabase();

    expect(() => {
      new CharacterCardStore({ db: profileDb }).ensureSeed();
    }).toThrow();

    const { card } = createCharacterRuntime(profileDb);

    expect(card.current().id).toBe(EMA_CARD_ID);
    expect(
      profileDb.sqlite
        .prepare('SELECT id FROM live2d_models WHERE id = ?')
        .get('ema'),
    ).toEqual({ id: 'ema' });
  });

  it('重复构造保持内置模型和角色卡各一条', () => {
    const profileDb = openProfileDatabase();

    createCharacterRuntime(profileDb);
    createCharacterRuntime(profileDb);

    const live2dCount = profileDb.sqlite
      .prepare('SELECT COUNT(*) AS count FROM live2d_models WHERE id = ?')
      .get('ema') as { count: number };
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
