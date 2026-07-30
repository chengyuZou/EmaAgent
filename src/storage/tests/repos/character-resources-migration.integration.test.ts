// 测试 Profile v17 将共享旧 Live2D 与重复声音 ID 安全迁入显式角色资源表。

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { MigrationsRunner } from '../../index.js';

const opened: BetterSqlite3.Database[] = [];

afterEach(() => {
  while (opened.length > 0) opened.pop()!.close();
});

function createV16Profile(): BetterSqlite3.Database {
  const sqlite = new BetterSqlite3(':memory:');
  opened.push(sqlite);
  const directory = fileURLToPath(new URL('../../migrations/profile/', import.meta.url));
  const files = readdirSync(directory)
    .filter((file) => /^(00[1-9]|01[0-6])_.*\.sql$/.test(file))
    .sort();
  for (const file of files) {
    sqlite.exec(readFileSync(new URL(`../../migrations/profile/${file}`, import.meta.url), 'utf8'));
  }
  sqlite.pragma('user_version = 16');
  return sqlite;
}

describe('profile v17 character resources migration', () => {
  it('共享旧模型按角色生成独立身份，重复声音 ID 不冲突且各自有主项', () => {
    const sqlite = createV16Profile();
    sqlite.prepare(
      `INSERT INTO live2d_models (
         id, name, format, storage_path, params_json,
         is_builtin, created_at, updated_at
       ) VALUES ('shared', 'Shared', 'live2d', 'live2d/shared.model3.json', '{}', 1, 1, 1)`,
    ).run();

    const voiceProfile = JSON.stringify({
      refAudios: [{
        id: 'same-ref',
        label: 'Voice',
        refAudioPath: 'voiceRefs/voice.mp3',
        promptText: 'hello',
        promptLang: 'en',
      }],
      primaryId: 'same-ref',
    });
    for (const id of ['card-a', 'card-b']) {
      sqlite.prepare(
        `INSERT INTO character_cards (
           id, name, system_prompt, live2d_model_id, voice_profile_json,
           created_at, updated_at
         ) VALUES (?, ?, 'prompt', 'shared', ?, 1, 1)`,
      ).run(id, id, voiceProfile);
    }

    new MigrationsRunner(sqlite, 'profile').run();

    expect(sqlite.pragma('user_version', { simple: true })).toBe(17);
    expect(sqlite.prepare(
      `SELECT id, character_card_id FROM character_live2d_variants
       ORDER BY character_card_id`,
    ).all()).toEqual([
      { id: 'card-a:shared', character_card_id: 'card-a' },
      { id: 'card-b:shared', character_card_id: 'card-b' },
    ]);
    expect(sqlite.prepare(
      `SELECT id, character_card_id, is_primary FROM character_voice_references
       ORDER BY character_card_id`,
    ).all()).toEqual([
      { id: 'card-a:same-ref:0', character_card_id: 'card-a', is_primary: 1 },
      { id: 'card-b:same-ref:0', character_card_id: 'card-b', is_primary: 1 },
    ]);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    const cardColumns = sqlite.prepare('PRAGMA table_info(character_cards)').all() as Array<{
      name: string;
    }>;
    expect(cardColumns.map((column) => column.name)).not.toContain('live2d_model_id');
    expect(cardColumns.map((column) => column.name)).not.toContain('voice_profile_json');
    expect(sqlite.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'live2d_models'`,
    ).get()).toBeUndefined();
  });

  it('不把旧绝对路径、越界音频和跨角色目录模型提升成可信资源', () => {
    const sqlite = createV16Profile();
    sqlite.prepare(
      `INSERT INTO live2d_models (
         id, name, format, storage_path, params_json,
         is_builtin, created_at, updated_at
       ) VALUES ('unsafe', 'Unsafe', 'live2d', 'cards/other/live2d/model.json', '{}', 0, 1, 1)`,
    ).run();
    sqlite.prepare(
      `INSERT INTO character_cards (
         id, name, system_prompt, live2d_model_id, voice_profile_json,
         created_at, updated_at
       ) VALUES ('card-a', 'A', 'prompt', 'unsafe', ?, 1, 1)`,
    ).run(JSON.stringify({
      refAudios: [
        {
          id: 'unsafe-ref',
          label: 'Unsafe',
          refAudioPath: '../secret.wav',
          promptText: 'x',
          promptLang: 'en',
        },
        {
          id: 'nested-ref',
          label: 'Nested',
          refAudioPath: 'voiceRefs/nested/secret.wav',
          promptText: 'x',
          promptLang: 'en',
        },
        {
          id: 'wrong-root',
          label: 'Wrong root',
          refAudioPath: 'audio/secret.wav',
          promptText: 'x',
          promptLang: 'en',
        },
      ],
    }));

    new MigrationsRunner(sqlite, 'profile').run();

    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM character_live2d_variants').get())
      .toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM character_voice_references').get())
      .toEqual({ count: 0 });
  });
});
