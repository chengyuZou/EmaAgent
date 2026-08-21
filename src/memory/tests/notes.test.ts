// 验证三种便签归属和不可覆盖写入.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  characterRelationshipNotesDir,
  sharedRelationshipNotesDir,
  workMemoryNotesDir,
} from '../common/paths.js';
import {
  createMemoryNote,
  memoryNoteFileName,
} from '../common/notes.js';
import {
  MemoryNoteAlreadyExistsError,
  MemoryNoteCharacterRequiredError,
  MemoryNoteEmptyError,
} from '../errors.js';

afterEach(() => {
  vi.restoreAllMocks();
});

async function useTemporaryHome(): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ema-memory-note-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
}

describe('Memory note paths', () => {
  it('separates Work, shared relationship and character relationship notes', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\Ema');

    expect(workMemoryNotesDir()).toBe(
      path.join('C:\\Users\\Ema', '.ema-agent', 'memories', 'work', 'extensions', 'notes'),
    );
    expect(sharedRelationshipNotesDir()).toBe(
      path.join('C:\\Users\\Ema', '.ema-agent', 'memories', 'relationship', 'extensions', 'notes'),
    );
    expect(characterRelationshipNotesDir('ema')).toBe(
      path.join('C:\\Users\\Ema', '.ema-agent', 'memories', 'relationship', 'characters', 'ema', 'extensions', 'notes'),
    );
  });
});

describe('createMemoryNote', () => {
  it('writes each target to its own directory', async () => {
    await useTemporaryHome();
    const createdAt = new Date('2026-08-20T14:30:22.000Z');

    const work = await createMemoryNote(
      { kind: 'work' },
      'TypeScript style',
      '不要使用行内动态 import。',
      createdAt,
    );
    const shared = await createMemoryNote(
      { kind: 'relationshipShared' },
      'User name',
      '所有角色都称呼用户为 Legion。',
      createdAt,
    );
    const character = await createMemoryNote(
      { kind: 'relationshipCharacter', characterDirectoryName: 'ema' },
      'First date',
      '今天是第一次约会。',
      createdAt,
    );

    expect(await fs.readFile(work, 'utf8')).toBe('不要使用行内动态 import。');
    expect(shared).toContain(path.join('relationship', 'extensions', 'notes'));
    expect(character).toContain(path.join('characters', 'ema', 'extensions', 'notes'));
  });

  it('rejects empty content and an empty character directory name', async () => {
    await useTemporaryHome();
    await expect(createMemoryNote({ kind: 'work' }, 'empty', '  '))
      .rejects.toBeInstanceOf(MemoryNoteEmptyError);
    await expect(createMemoryNote(
      { kind: 'relationshipCharacter', characterDirectoryName: '' },
      'missing',
      'fact',
    )).rejects.toBeInstanceOf(MemoryNoteCharacterRequiredError);
  });

  it('does not overwrite an existing note', async () => {
    await useTemporaryHome();
    const createdAt = new Date('2026-08-20T14:30:22.000Z');
    const first = await createMemoryNote(
      { kind: 'work' },
      'same-note',
      'first',
      createdAt,
    );
    await expect(createMemoryNote(
      { kind: 'work' },
      'same-note',
      'second',
      createdAt,
    )).rejects.toBeInstanceOf(MemoryNoteAlreadyExistsError);
    expect(await fs.readFile(first, 'utf8')).toBe('first');
  });

  it('保留中文标题并用毫秒避免同秒便签撞名', () => {
    expect(memoryNoteFileName(
      '角色约定',
      new Date('2026-08-20T14:30:22.000Z'),
    )).toBe('2026-08-20T14-30-22-000-角色约定.md');
  });
});
