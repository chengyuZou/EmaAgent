import { describe, expect, it } from 'vitest';
import {
  CharacterIllustrationRepo,
  CharacterLive2dModelRepo,
  CharacterRepo,
  CharacterVoiceSampleRepo,
  Database,
} from '../../index.js';

describe('Character resource persistence', () => {
  it('只保存资源事实，并在更换主要资源时更新旧主要资源时间', () => {
    const database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    try {
      new CharacterRepo(database.sqlite).insert({
        name: '角色',
        personaPrompt: '人设',
        createdAt: 1,
        updatedAt: 1,
      });

      const live2d = new CharacterLive2dModelRepo(database.sqlite);
      live2d.insert({ name: 'a', characterName: '角色', displayName: 'A', isPrimary: true, createdAt: 1, updatedAt: 1 });
      live2d.insert({ name: 'b', characterName: '角色', displayName: 'B', isPrimary: true, createdAt: 5, updatedAt: 5 });
      expect(live2d.find('角色', 'a')).toMatchObject({ is_primary: 0, updated_at: 5 });

      const illustrations = new CharacterIllustrationRepo(database.sqlite);
      illustrations.insert({ name: 'a.png', characterName: '角色', displayName: 'A', isPrimary: true, byteSize: 1, createdAt: 2, updatedAt: 2 });
      illustrations.insert({ name: 'b.png', characterName: '角色', displayName: 'B', isPrimary: true, byteSize: 1, createdAt: 6, updatedAt: 6 });
      expect(illustrations.find('角色', 'a.png')).toMatchObject({ is_primary: 0, updated_at: 6 });

      const voices = new CharacterVoiceSampleRepo(database.sqlite);
      voices.insert({ name: 'a.wav', characterName: '角色', displayName: 'A', promptText: 'A', promptLang: 'zh', isPrimary: true, mimeType: 'audio/wav', createdAt: 3, updatedAt: 3 });
      voices.insert({ name: 'b.wav', characterName: '角色', displayName: 'B', promptText: 'B', promptLang: 'zh', isPrimary: true, mimeType: 'audio/wav', createdAt: 7, updatedAt: 7 });
      expect(voices.find('角色', 'a.wav')).toMatchObject({ is_primary: 0, updated_at: 7 });

      const live2dColumns = database.sqlite.prepare('PRAGMA table_info(character_live2d_models)').all() as { name: string }[];
      expect(live2dColumns.map(column => column.name)).not.toContain('emotion_vocab_json');
      expect(live2dColumns.map(column => column.name)).not.toContain('motion_vocab_json');
    } finally {
      database.close();
    }
  });
});
