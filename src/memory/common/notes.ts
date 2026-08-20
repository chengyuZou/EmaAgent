// 把用户明确要求记住的内容写入对应轨道的待整合便签.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  characterRelationshipNotesDir,
  memoryFileSlug,
  sharedRelationshipNotesDir,
  workMemoryNotesDir,
} from './paths.js';
import {
  MemoryNoteAlreadyExistsError,
  MemoryNoteCharacterRequiredError,
  MemoryNoteEmptyError,
} from '../errors.js';

export type MemoryNoteTarget =
  | { readonly kind: 'work' }
  | { readonly kind: 'relationshipShared' }
  | {
      readonly kind: 'relationshipCharacter';
      readonly characterDirectoryName: string;
    };

export function memoryNoteFileName(
  title: string,
  createdAt: Date = new Date(),
): string {
  const timestamp = createdAt
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19);
  return `${timestamp}-${memoryFileSlug(title) ?? 'note'}.md`;
}

export async function createMemoryNote(
  target: MemoryNoteTarget,
  title: string,
  content: string,
  createdAt: Date = new Date(),
): Promise<string> {
  if (content.trim().length === 0) {
    throw new MemoryNoteEmptyError();
  }

  const directory = memoryNoteDirectory(target);
  await fs.mkdir(directory, { recursive: true });

  const filePath = path.join(
    directory,
    memoryNoteFileName(title, createdAt),
  );
  try {
    await fs.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new MemoryNoteAlreadyExistsError(filePath);
    }
    throw error;
  }
  return filePath;
}

function memoryNoteDirectory(target: MemoryNoteTarget): string {
  switch (target.kind) {
    case 'work':
      return workMemoryNotesDir();
    case 'relationshipShared':
      return sharedRelationshipNotesDir();
    case 'relationshipCharacter':
      if (target.characterDirectoryName.length === 0) {
        throw new MemoryNoteCharacterRequiredError();
      }
      return characterRelationshipNotesDir(target.characterDirectoryName);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
