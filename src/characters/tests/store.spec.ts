// 测试角色卡与三类表现资源的种子、聚合、主项切换和复制边界。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '@ema-agent/storage';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CharacterCardStore } from '../store.js';
import { EMA_CARD_ID } from '../seed/index.js';
import type { CharacterCardInput } from '../types.js';
import type { CharacterCardId } from '@ema-agent/ids';

// ── helpers ───────────────────────────────────────────────────────────────────

function minimalInput(overrides: Partial<CharacterCardInput> = {}): CharacterCardInput {
  return {
    name: 'Test Card',
    systemPrompt: 'You are a test.',
    ...overrides,
  };
}

describe('CharacterCardStore', () => {
  let db: Database;
  let store: CharacterCardStore;
  let resourceRoot: string;

  beforeEach(() => {
    db = new Database({ memory: true, kind: 'profile' });
    db.migrate();
    resourceRoot = mkdtempSync(join(tmpdir(), 'ema-character-store-'));
    store = new CharacterCardStore({
      db,
      resourceRoots: {
        builtinCardsRoot: join(resourceRoot, 'builtin'),
        userCardsRoot: join(resourceRoot, 'user'),
      },
    });
    store.ensureSeed();
  });

  afterEach(() => {
    db.close();
    rmSync(resourceRoot, { recursive: true, force: true });
  });

  // ─── seed & init ──────────────────────────────────────────────────────────

  describe('ensureSeed', () => {
    it('sets the built-in Ema card as active on first call', () => {
      const current = store.current();
      expect(current.id).toBe(EMA_CARD_ID);
      expect(current.isBuiltin).toBe(true);
      expect(current.isActive).toBe(true);
      expect(current.live2dVariants).toHaveLength(1);
      expect(current.live2dVariants[0]).toMatchObject({
        entryPath: 'live2d/ema.model3.json',
        isPrimary: true,
      });
      expect(current.voiceReferences).toHaveLength(1);
      expect(current.voiceReferences[0]?.isPrimary).toBe(true);
    });

    it('is idempotent — calling twice does not duplicate or throw', () => {
      store.ensureSeed();
      store.ensureSeed();
      const cards = store.list();
      const emaCards = cards.filter((c) => c.id === EMA_CARD_ID);
      expect(emaCards).toHaveLength(1);
    });

    it('v17 迁移行(同路径不同 id)不触发唯一约束错误,也不重复插入', () => {
      // 模拟 v17 迁移产生的行:id 口径与种子不同,relative_path 与种子一致。
      db.sqlite.prepare(
        `DELETE FROM character_voice_references WHERE character_card_id = 'ema'`,
      ).run();
      db.sqlite.prepare(
        `INSERT INTO character_voice_references (
           id, character_card_id, label, relative_path, prompt_text, prompt_lang,
           position, is_primary, enabled, mime_type, created_at, updated_at
         ) VALUES ('ema:legacy:0', 'ema', '迁移旧行', 'voiceRefs/ra_ema001.mp3', '旧', 'zh',
                   0, 1, 1, 'audio/mpeg', 1, 1)`,
      ).run();
      db.sqlite.prepare(
        `DELETE FROM character_live2d_variants WHERE character_card_id = 'ema'`,
      ).run();
      db.sqlite.prepare(
        `INSERT INTO character_live2d_variants (
           id, character_card_id, label, format, entry_path, position, is_primary,
           enabled, is_builtin, created_at, updated_at
         ) VALUES ('ema:old-model', 'ema', '迁移旧模型', 'live2d', 'live2d/ema.model3.json',
                   0, 1, 1, 1, 1, 1)`,
      ).run();

      expect(() => store.ensureSeed()).not.toThrow();
      const current = store.current();
      expect(
        current.voiceReferences.filter((v) => v.relativePath === 'voiceRefs/ra_ema001.mp3'),
      ).toHaveLength(1);
      expect(
        current.live2dVariants.filter((v) => v.entryPath === 'live2d/ema.model3.json'),
      ).toHaveLength(1);
    });
  });

  describe('current', () => {
    it('returns the active card', () => {
      const card = store.current();
      expect(card.isActive).toBe(true);
    });

    it('throws when no card is active', () => {
      // deactivate the only card by activating nothing (simulate corrupted state)
      const db2 = new Database({ memory: true, kind: 'profile' });
      db2.migrate();
      const emptyStore = new CharacterCardStore({
        db: db2,
        resourceRoots: {
          builtinCardsRoot: join(resourceRoot, 'builtin'),
          userCardsRoot: join(resourceRoot, 'user'),
        },
      });
      // never called ensureSeed
      expect(() => emptyStore.current()).toThrow('no active character card');
      db2.close();
    });
  });

  // ─── list & get ───────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns all cards including the seed', () => {
      store.create(minimalInput({ name: 'Second' }));
      const all = store.list();
      expect(all.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('get', () => {
    it('returns the card by id', () => {
      const card = store.get(EMA_CARD_ID as CharacterCardId);
      expect(card).toBeDefined();
      expect(card!.id).toBe(EMA_CARD_ID);
    });

    it('returns undefined for unknown id', () => {
      expect(store.get('nonexistent' as CharacterCardId)).toBeUndefined();
    });
  });

  // ─── create ───────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a card with full input', () => {
      const input: CharacterCardInput = {
        name: 'Full Card',
        systemPrompt: 'Full prompt.',
        emotionVocabulary: ['happy', 'sad'],
        motionVocabulary: ['wave', 'nod'],
      };
      const card = store.create(input);
      expect(card.name).toBe('Full Card');
      expect(card.emotionVocabulary).toEqual(['happy', 'sad']);
      expect(card.motionVocabulary).toEqual(['wave', 'nod']);
      expect(card.isBuiltin).toBe(false);
      expect(card.isActive).toBe(false);
    });

    it('creates a card with minimal input (only name + systemPrompt)', () => {
      const card = store.create(minimalInput());
      expect(card.name).toBe('Test Card');
      expect(card.systemPrompt).toBe('You are a test.');
      expect(card.emotionVocabulary).toEqual([]);
      expect(card.motionVocabulary).toEqual([]);
    });

    it('拒绝只有空白的角色 Prompt', () => {
      expect(() => store.create(minimalInput({ systemPrompt: ' \n ' })))
        .toThrow('character prompt is empty');
    });
  });

  describe('voice references', () => {
    it('删除主音频后由后端按稳定顺序提升下一条', async () => {
      const card = store.create(minimalInput());
      const first = store.addVoiceReference(card.id, {
        label: 'First',
        relativePath: 'voiceRefs/first.wav',
        promptText: 'first',
        promptLang: 'en',
        position: 0,
        isPrimary: true,
        mimeType: 'audio/wav',
      });
      const second = store.addVoiceReference(card.id, {
        label: 'Second',
        relativePath: 'voiceRefs/second.wav',
        promptText: 'second',
        promptLang: 'en',
        position: 1,
        mimeType: 'audio/wav',
      });

      await store.deleteManagedVoiceReference(card.id, first.id);

      expect(store.get(card.id)?.voiceReferences).toEqual([
        expect.objectContaining({ id: second.id, isPrimary: true }),
      ]);
    });
  });

  describe('resource metadata updates', () => {
    it('list() 批量装配:多张卡的资源正确分组,不串卡', () => {
      const alpha = store.create(minimalInput({ name: 'Alpha' }));
      const beta = store.create(minimalInput({ name: 'Beta' }));
      store.addLive2dVariant(alpha.id, {
        label: 'AlphaModel', format: 'live2d', entryPath: 'live2d/a.model3.json',
      });
      store.addPortrait(beta.id, {
        label: 'BetaPortrait', relativePath: 'portraits/b.png',
        mimeType: 'image/png', byteSize: 10, width: 1, height: 1,
      });
      store.addVoiceReference(beta.id, {
        label: 'BetaVoice', relativePath: 'voiceRefs/b.mp3',
        promptText: 'x', promptLang: 'zh', mimeType: 'audio/mpeg',
      });

      const byId = new Map(store.list().map((card) => [card.id, card]));
      expect(byId.get(alpha.id)!.live2dVariants).toHaveLength(1);
      expect(byId.get(alpha.id)!.portraits).toHaveLength(0);
      expect(byId.get(alpha.id)!.voiceReferences).toHaveLength(0);
      expect(byId.get(beta.id)!.live2dVariants).toHaveLength(0);
      expect(byId.get(beta.id)!.portraits).toHaveLength(1);
      expect(byId.get(beta.id)!.voiceReferences).toHaveLength(1);
    });

    it('禁用主 Live2D 后提升下一候选，并让资源 revision 单调前进', () => {
      const card = store.create(minimalInput());
      const first = store.addLive2dVariant(card.id, {
        label: 'First',
        format: 'live2d',
        entryPath: 'live2d/first.model3.json',
        position: 0,
        isPrimary: true,
      });
      const second = store.addLive2dVariant(card.id, {
        label: 'Second',
        format: 'live2d',
        entryPath: 'live2d/second.model3.json',
        position: 1,
      });

      const updated = store.updateLive2dVariant(card.id, first.id, {
        label: 'Disabled',
        position: 3,
        enabled: false,
      });

      expect(updated).toMatchObject({
        id: first.id,
        label: 'Disabled',
        position: 3,
        enabled: false,
        isPrimary: false,
      });
      expect(updated!.updatedAt).toBeGreaterThan(first.updatedAt);
      expect(store.get(card.id)?.live2dVariants).toEqual([
        expect.objectContaining({ id: second.id, isPrimary: true }),
        expect.objectContaining({ id: first.id, isPrimary: false }),
      ]);
    });

    it('重新启用唯一立绘时自动恢复主项，参考音频也可修改展示字段', () => {
      const card = store.create(minimalInput());
      const portrait = store.addPortrait(card.id, {
        label: 'Portrait',
        relativePath: 'portraits/main.png',
        isPrimary: true,
        mimeType: 'image/png',
        byteSize: 1,
        width: 1,
        height: 1,
      });
      const voice = store.addVoiceReference(card.id, {
        label: 'Voice',
        relativePath: 'voiceRefs/main.wav',
        promptText: 'hello',
        promptLang: 'en',
        isPrimary: true,
        mimeType: 'audio/wav',
      });

      expect(store.updatePortrait(card.id, portrait.id, { enabled: false }))
        .toMatchObject({ enabled: false, isPrimary: false });
      expect(store.updatePortrait(card.id, portrait.id, { enabled: true }))
        .toMatchObject({ enabled: true, isPrimary: true });
      expect(store.updateVoiceReference(card.id, voice.id, {
        label: 'Updated voice',
        position: 8,
        enabled: false,
      })).toMatchObject({
        label: 'Updated voice',
        position: 8,
        enabled: false,
        isPrimary: false,
      });
    });
  });

  // ─── activate ─────────────────────────────────────────────────────────────

  describe('activate', () => {
    it('switches the active card and returns the new id', () => {
      const card = store.create(minimalInput({ name: 'New Active' }));
      const result = store.activate(card.id);
      expect(result).toBe(card.id);
      expect(store.current().id).toBe(card.id);

      const old = store.get(EMA_CARD_ID as CharacterCardId);
      expect(old?.isActive).toBe(false);
    });

    it('throws when activating a non-existent card', () => {
      expect(() => store.activate('ghost' as CharacterCardId)).toThrow();
    });

    it('数据库被外部写坏后仍拒绝激活空 Prompt', () => {
      const card = store.create(minimalInput());
      db.sqlite.prepare(
        'UPDATE character_cards SET system_prompt = ? WHERE id = ?',
      ).run(' ', card.id);
      expect(() => store.activate(card.id)).toThrow('character prompt is empty');
    });
  });

  // ─── update ───────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates the card name', () => {
      const card = store.create(minimalInput());
      const updated = store.update(card.id, { name: 'Renamed' });
      expect(updated.name).toBe('Renamed');
      expect(store.get(card.id)?.name).toBe('Renamed');
    });

    it('updates systemPrompt', () => {
      const card = store.create(minimalInput());
      const updated = store.update(card.id, {
        systemPrompt: 'New prompt',
      });
      expect(updated.systemPrompt).toBe('New prompt');
    });

    it('does not affect fields not included in patch', () => {
      const card = store.create(minimalInput({ name: 'Original' }));
      store.update(card.id, { systemPrompt: 'Changed' });
      const fetched = store.get(card.id)!;
      expect(fetched.name).toBe('Original');
    });
  });

  // ─── duplicate ────────────────────────────────────────────────────────────

  describe('duplicate', () => {
    it('creates a copy with (Copy) suffix and distinct id', () => {
      const ema = store.get(EMA_CARD_ID as CharacterCardId)!;
      const dup = store.duplicate(ema.id);
      expect(dup.id).not.toBe(ema.id);
      expect(dup.name).toContain(ema.name);
      expect(dup.name).toContain('(Copy)');
      expect(dup.systemPrompt).toBe(ema.systemPrompt);
      expect(dup.isBuiltin).toBe(false);
    });

    it('copies vocabularies and optional fields', () => {
      const ema = store.get(EMA_CARD_ID as CharacterCardId)!;
      const dup = store.duplicate(ema.id);
      expect(dup.emotionVocabulary).toEqual(ema.emotionVocabulary);
      expect(dup.motionVocabulary).toEqual(ema.motionVocabulary);
    });

    it('只复制角色定义，不复用原角色的资源路径', () => {
      const card = store.create(minimalInput());
      store.addVoiceReference(card.id, {
        label: 'Main',
        relativePath: 'voiceRefs/ref.wav',
        promptText: 'hello',
        promptLang: 'en',
        mimeType: 'audio/wav',
        isPrimary: true,
      });

      const dup = store.duplicate(card.id);

      expect(dup.voiceReferences).toEqual([]);
      expect(dup.live2dVariants).toEqual([]);
      expect(dup.portraits).toEqual([]);
    });

    it('throws when duplicating a non-existent card', () => {
      expect(() => store.duplicate('ghost' as CharacterCardId)).toThrow(
        'character card not found',
      );
    });
  });

  // ─── delete ───────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('removes a non-builtin card', async () => {
      const card = store.create(minimalInput());
      await store.deleteManagedCharacter(card.id);
      expect(store.get(card.id)).toBeUndefined();
    });

    it('拒绝绕过 Route 删除当前活动角色', async () => {
      const card = store.create(minimalInput());
      store.activate(card.id);

      await expect(store.deleteManagedCharacter(card.id))
        .rejects.toThrow('active character cannot be deleted');
      expect(store.get(card.id)?.isActive).toBe(true);
    });
  });
});
