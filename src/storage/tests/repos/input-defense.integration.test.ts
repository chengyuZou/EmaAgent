import { describe, expect, it } from 'vitest';
import {
  CharacterRepo,
  Database,
  SettingSerializationError,
  SettingsRepo,
} from '../../index.js';

type TestDatabaseKind = 'profile' | 'data';

function withDatabase<T>(kind: TestDatabaseKind, run: (database: Database) => T): T {
  const database = new Database({ memory: true, kind });
  database.migrate();
  try {
    return run(database);
  } finally {
    database.close();
  }
}

describe('N-003 Settings JSON 防御', () => {
  it('区分有效、缺失和损坏设置，get 对损坏值安全回退', () => {
    withDatabase('profile', (database) => {
      const repo = new SettingsRepo(database.sqlite);
      repo.set('valid', { enabled: true }, 1);
      database.sqlite
        .prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
        .run('corrupted', '{invalid-json', 2);

      expect(repo.read('valid')).toEqual({
        status: 'found',
        value: { enabled: true },
      });
      expect(repo.read('missing')).toEqual({ status: 'missing' });
      expect(repo.read('corrupted')).toEqual({
        status: 'corrupted',
        rawValue: '{invalid-json',
      });
      expect(repo.get('corrupted')).toBeUndefined();
      expect(repo.all().find((row) => row.key === 'corrupted')?.value_json)
        .toBe('{invalid-json');
    });
  });

  it('拒绝 undefined 和循环引用且不写入数据库', () => {
    withDatabase('profile', (database) => {
      const repo = new SettingsRepo(database.sqlite);
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;

      expect(() => repo.set('undefined', undefined))
        .toThrow(SettingSerializationError);
      expect(() => repo.set('circular', circular))
        .toThrow(SettingSerializationError);
      expect(repo.all()).toEqual([]);
    });
  });
});

describe('N-004 Character 更新契约', () => {
  it('name 是主键且 update 只能修改角色业务字段', () => {
    withDatabase('profile', (database) => {
      const repo = new CharacterRepo(database.sqlite);
      repo.insert({
        name: 'character-a',
        displayName: 'Character A',
        personaPrompt: '人设',
        isActive: true,
        createdAt: 1,
        updatedAt: 1,
      });

      repo.update('character-a', { displayName: 'After', stageKind: 'blank', updatedAt: 2 });

      expect(repo.findByName('character-a')).toMatchObject({
        name: 'character-a',
        display_name: 'After',
        stage_kind: 'blank',
        is_active: 1,
        updated_at: 2,
      });
    });
  });

  it('name 主键拒绝重复角色身份', () => {
    withDatabase('profile', (database) => {
      const repo = new CharacterRepo(database.sqlite);
      repo.insert({
        name: 'same',
        displayName: 'A',
        personaPrompt: '人设',
        createdAt: 1,
        updatedAt: 1,
      });
      expect(() => repo.insert({
        name: 'same',
        displayName: 'B',
        personaPrompt: '人设',
        createdAt: 2,
        updatedAt: 2,
      })).toThrow();
      expect(repo.findByName('same')?.display_name).toBe('A');
    });
  });
});
