// 测试角色与三类表现资源的种子、聚合、主项切换、复制与物理名称边界。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database, SettingsRepo } from '@ema-agent/storage';
import { SettingsStore } from '@ema-agent/settings';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CharacterStore } from '../store.js';
import { EMA_CHARACTER_ID } from '../seed/index.js';
import {
  CHARACTER_SETTING_DEFINITIONS,
  characterPromptLimitsGroup,
} from '../settings.js';
import {
  CharacterActiveDeleteError,
  CharacterDirectoryConflictError,
  CharacterReadOnlyError,
} from '../errors.js';
import type { CharacterInput } from '../types.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function minimalInput(overrides: Partial<CharacterInput> = {}): CharacterInput {
  return {
    name: 'Test Character',
    promptBlocks: [{ name: '基础人设', content: 'You are a test character.' }],
    ...overrides,
  };
}

describe('CharacterStore', () => {
  let db: Database;
  let store: CharacterStore;
  let charactersRoot: string;

  beforeEach(() => {
    db = new Database({ memory: true, kind: 'profile' });
    db.migrate();
    charactersRoot = mkdtempSync(join(tmpdir(), 'ema-characters-'));
    const settings = new SettingsStore(new SettingsRepo(db.sqlite), {
      definitions: CHARACTER_SETTING_DEFINITIONS,
      groups: [characterPromptLimitsGroup],
    });
    store = new CharacterStore(db, charactersRoot, settings);
    store.ensureSeed();
  });

  afterEach(() => {
    db.close();
    rmSync(charactersRoot, { recursive: true, force: true });
  });

  // ─── seed & init ──────────────────────────────────────────────────────────

  describe('ensureSeed', () => {
    it('sets the built-in Ema as active on first call, with blocks and resources', () => {
      const current = store.current();
      expect(current.id).toBe(EMA_CHARACTER_ID);
      expect(current.isBuiltin).toBe(true);
      expect(current.isActive).toBe(true);
      expect(current.promptBlocks).toHaveLength(1);
      expect(current.promptBlocks[0]?.name).toBe('基础人设');
      expect(current.promptBlocks[0]?.enabled).toBe(true);
      expect(current.live2dModels).toHaveLength(1);
      expect(current.live2dModels[0]).toMatchObject({
        directoryName: 'ema',
        isPrimary: true,
      });
      expect(current.voiceSamples).toHaveLength(1);
      expect(current.voiceSamples[0]?.fileName).toBe('ra_ema001.mp3');
      expect(current.voiceSamples[0]?.isPrimary).toBe(true);
    });

    it('is idempotent — calling twice does not duplicate or throw', () => {
      store.ensureSeed();
      store.ensureSeed();
      const characters = store.list();
      expect(characters.filter(c => c.id === EMA_CHARACTER_ID)).toHaveLength(1);
    });
  });

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('inserts character with initial prompt blocks and derived directory name', () => {
      const created = store.create(minimalInput());
      expect(created.directoryName).toBe('Test Character');
      expect(created.promptBlocks).toHaveLength(1);
      expect(created.promptBlocks[0]?.name).toBe('基础人设');
      expect(created.promptBlocks[0]?.sortOrder).toBe(0);
    });

    it('rejects empty prompt blocks', () => {
      expect(() => store.create({ name: 'Empty', promptBlocks: [] }))
        .toThrow('至少需要一个');
      expect(() => store.create({
        name: 'Blank',
        promptBlocks: [{ name: 'x', content: '   ' }],
      })).toThrow('内容不能为空');
    });

    it('rejects duplicate directory names', () => {
      store.create(minimalInput({ name: 'Collision' }));
      expect(() => store.create(minimalInput({ name: 'Collision' })))
        .toThrow(CharacterDirectoryConflictError);
    });
  });

  describe('update', () => {
    it('renames without touching directory name', () => {
      const created = store.create(minimalInput({ name: 'Before' }));
      const updated = store.update(created.id, { name: 'After' });
      expect(updated.name).toBe('After');
      expect(updated.directoryName).toBe('Before');
    });

    it('refuses editing built-in character fields and prompt blocks', () => {
      expect(() => store.update(EMA_CHARACTER_ID, { name: 'Changed' }))
        .toThrow(CharacterReadOnlyError);
      expect(() => store.addPromptBlock(EMA_CHARACTER_ID, { name: 'x', content: 'y' }))
        .toThrow(CharacterReadOnlyError);
    });
  });

  describe('duplicate', () => {
    it('copies blocks with new ids and keeps original untouched', () => {
      const created = store.create(minimalInput());
      const copy = store.duplicate(created.id);
      expect(copy.id).not.toBe(created.id);
      expect(copy.name).toBe(`${created.name}(Copy)`);
      expect(copy.promptBlocks).toHaveLength(1);
      expect(copy.promptBlocks[0]?.id).not.toBe(created.promptBlocks[0]?.id);
      expect(copy.promptBlocks[0]?.content).toBe(created.promptBlocks[0]?.content);
    });
  });

  describe('delete', () => {
    it('cascades prompt blocks', async () => {
      const created = store.create(minimalInput());
      const blockId = created.promptBlocks[0]!.id;
      await store.deleteManagedCharacter(created.id);
      expect(store.get(created.id)).toBeUndefined();
      expect(db.sqlite.prepare(
        'SELECT 1 FROM character_prompt_blocks WHERE id = ?',
      ).get(blockId)).toBeUndefined();
    });

    it('refuses builtin characters', async () => {
      await expect(store.deleteManagedCharacter(EMA_CHARACTER_ID))
        .rejects.toThrow(CharacterReadOnlyError);
    });

    it('refuses the currently active character', async () => {
      const created = store.create(minimalInput({ name: 'Active' }));
      store.activate(created.id);
      await expect(store.deleteManagedCharacter(created.id))
        .rejects.toThrow(CharacterActiveDeleteError);
    });
  });

  // ─── active / switched ────────────────────────────────────────────────────

  describe('activate', () => {
    it('switches active character and emits switched event', () => {
      const created = store.create(minimalInput());
      const events: string[] = [];
      store.onSwitched(next => events.push(next.id));
      store.activate(created.id);
      expect(store.current().id).toBe(created.id);
      expect(events).toEqual([created.id]);
    });
  });

  // ─── prompt assembly ──────────────────────────────────────────────────────

  describe('prompt blocks', () => {
    it('list orders blocks by sort order', () => {
      const created = store.create(minimalInput({
        promptBlocks: [
          { name: 'second', content: 'B' },
          { name: 'first', content: 'A' },
        ],
      }));
      expect(created.promptBlocks.map(b => b.content)).toEqual(['B', 'A']);
    });

    it('supports add, update, reorder and delete through one validation path', () => {
      const created = store.create(minimalInput());
      const second = store.addPromptBlock(created.id, { name: '补充', content: 'second' });
      const first = created.promptBlocks[0]!;
      expect(store.reorderPromptBlocks(created.id, [second.id, first.id])).toBe(true);
      expect(store.updatePromptBlock(created.id, second.id, { enabled: false })?.enabled).toBe(false);
      expect(store.deletePromptBlock(created.id, second.id)).toBe(true);
      expect(store.get(created.id)?.promptBlocks.map((block) => block.id)).toEqual([first.id]);
    });

    it('rejects duplicate reorder ids and reserved Live2D tags', () => {
      const created = store.create(minimalInput());
      const second = store.addPromptBlock(created.id, { name: '补充', content: 'second' });
      expect(store.reorderPromptBlocks(created.id, [second.id, second.id])).toBe(false);
      expect(() => store.addPromptBlock(created.id, {
        name: 'bad',
        content: '不要输出 <Emotion>happy</Emotion>',
      })).toThrow('不能包含');
    });
  });
});
