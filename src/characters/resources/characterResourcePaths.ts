// 统一解析角色资源路径，并阻止绝对路径、目录穿越与符号链接逃逸。

import fs from 'node:fs';
import path from 'node:path';
import type { CharacterCardId } from '@ema-agent/ids';
import { CharacterResourcePathError } from '../errors.js';

export interface CharacterResourceRoots {
  readonly builtinCardsRoot: string;
  readonly userCardsRoot: string;
}

export type CharacterResourceKind = 'live2d' | 'portrait' | 'voiceReference';

const SINGLE_FILE_DIRECTORIES: Readonly<Record<
  Exclude<CharacterResourceKind, 'live2d'>,
  string
>> = {
  portrait: 'portraits',
  voiceReference: 'voiceRefs',
};
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const WINDOWS_FORBIDDEN_CHARS = /[<>:"|?*\u0000-\u001f]/u;
const MAX_RELATIVE_PATH_LENGTH = 240;

export class CharacterResourcePaths {
  constructor(private readonly roots: CharacterResourceRoots) {}

  cardRoot(characterId: CharacterCardId, isBuiltin: boolean): string {
    assertSafeSegment(characterId);
    const cardsRoot = isBuiltin
      ? this.roots.builtinCardsRoot
      : this.roots.userCardsRoot;
    return path.join(cardsRoot, characterId);
  }

  resolve(
    characterId: CharacterCardId,
    isBuiltin: boolean,
    relativePath: string,
    kind: CharacterResourceKind,
  ): string {
    assertCanonicalRelativePath(relativePath, kind);
    const cardsRoot = isBuiltin
      ? this.roots.builtinCardsRoot
      : this.roots.userCardsRoot;
    const characterRoot = this.cardRoot(characterId, isBuiltin);
    const target = path.resolve(characterRoot, ...relativePath.split('/'));
    assertContained(characterRoot, target, relativePath);
    // 物理边界从整个 cards 根判断，才能识别角色目录本身是 Junction 的逃逸。
    assertExistingPathContained(cardsRoot, target, relativePath);
    return target;
  }

  voiceReferencesDirectory(characterId: CharacterCardId): string {
    return path.join(this.cardRoot(characterId, false), 'voiceRefs');
  }
}

function assertSafeSegment(value: string): void {
  if (!value || value === '.' || value === '..' || /[\\/]/u.test(value)) {
    throw new CharacterResourcePathError(value, 'invalid_character_id');
  }
}

function assertCanonicalRelativePath(
  relativePath: string,
  kind: CharacterResourceKind,
): void {
  if (
    !relativePath
    || relativePath.length > MAX_RELATIVE_PATH_LENGTH
    || path.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
    || relativePath.includes('\\')
    || relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new CharacterResourcePathError(relativePath, 'non_canonical');
  }

  const parts = relativePath.split('/');
  if (parts.some((part) => (
    WINDOWS_FORBIDDEN_CHARS.test(part)
    || /[. ]$/u.test(part)
    || WINDOWS_RESERVED_NAME.test(part)
  ))) {
    throw new CharacterResourcePathError(relativePath, 'not_portable');
  }
  if (kind === 'live2d') {
    if (parts[0] !== 'live2d' || parts.length < 2) {
      throw new CharacterResourcePathError(relativePath, 'invalid_live2d_path');
    }
    return;
  }

  if (parts.length !== 2 || parts[0] !== SINGLE_FILE_DIRECTORIES[kind]) {
    throw new CharacterResourcePathError(relativePath, `invalid_${kind}_path`);
  }
}

function assertContained(root: string, target: string, source: string): void {
  const relative = path.relative(path.resolve(root), target);
  if (
    relative === ''
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new CharacterResourcePathError(source, 'outside_character_root');
  }
}

function assertExistingPathContained(root: string, target: string, source: string): void {
  const existingRoot = nearestExistingAncestor(root);
  const existingTarget = nearestExistingAncestor(target);
  if (!existingRoot || !existingTarget) return;

  const realRoot = fs.realpathSync.native(existingRoot);
  const realTarget = fs.realpathSync.native(existingTarget);
  const relative = path.relative(realRoot, realTarget);
  if (
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new CharacterResourcePathError(source, 'symlink_escape');
  }
}

function nearestExistingAncestor(value: string): string | null {
  let current = path.resolve(value);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}
