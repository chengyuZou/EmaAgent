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

/**
 * MemoryNoteTool 可见的便签目标：只有 kind，不含角色目录。
 * `relationshipCharacter` 的角色目录由根 Turn 注入的闭包绑定（模型不猜）。
 */
export type MemoryNoteTargetKind = 'work' | 'relationshipShared' | 'relationshipCharacter';

/** MemoryNoteTool 的宿主能力请求：模型只给 target/title/content；signal 由工具注入。 */
export interface AddMemoryNoteRequest {
  readonly target: MemoryNoteTargetKind;
  readonly title: string;
  readonly content: string;
  /** 工具执行取消信号；中止时底层写抛出，由执行框架收口。 */
  readonly signal?: AbortSignal;
}

/** MemoryNoteTool 的宿主能力：创建便签并返回文件路径。 */
export type AddMemoryNote = (request: AddMemoryNoteRequest) => Promise<string>;

/** 绑定本 Turn 冻结角色目录的便签能力（relationshipCharacter 由它补全）。 */
export function bindCharacterMemoryNote(characterDirectoryName: string): AddMemoryNote {
  return ({ target, title, content, signal }) => {
    const full: MemoryNoteTarget =
      target === 'relationshipCharacter'
        ? { kind: 'relationshipCharacter', characterDirectoryName }
        : { kind: target };
    return createMemoryNote(full, title, content, undefined, signal);
  };
}

export function memoryNoteFileName(
  title: string,
  createdAt: Date = new Date(),
): string {
  const timestamp = createdAt
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 23);
  return `${timestamp}-${memoryFileSlug(title) ?? 'note'}.md`;
}

export async function createMemoryNote(
  target: MemoryNoteTarget,
  title: string,
  content: string,
  createdAt: Date = new Date(),
  signal?: AbortSignal,
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
    await fs.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx', signal });
  } catch (error: unknown) {
    // 取消原样上抛，让执行框架走 completeCancellation。
    if (signal?.aborted) throw error;
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
