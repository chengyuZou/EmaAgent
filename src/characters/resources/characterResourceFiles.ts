// 提供角色资源事务所需的原子移动、清理和显式恢复清单。

import fs from 'node:fs';
import path from 'node:path';
import type { CharacterCardId } from '@ema-agent/ids';
import type { CharacterResourceKind } from './characterResourcePaths.js';

export const CHARACTER_RESOURCE_TRANSACTION_SCHEMA_VERSION = 1;
export const CHARACTER_RESOURCE_MANIFEST_NAME = 'operation.json';
export const CHARACTER_RESOURCE_PAYLOAD_NAME = 'payload';

export type CharacterResourceTransactionType = 'publish' | 'delete';
export type CharacterManagedResourceKind = CharacterResourceKind | 'character';

export interface CharacterResourceTransactionManifest {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly type: CharacterResourceTransactionType;
  readonly characterId: CharacterCardId;
  readonly resourceKind: CharacterManagedResourceKind;
  readonly resourceId: string;
  readonly relativePath: string;
}

export function createOperationDirectory(root: string, operationId: string): string {
  assertOperationId(operationId);
  fs.mkdirSync(root, { recursive: true });
  const directory = path.join(root, operationId);
  fs.mkdirSync(directory, { recursive: false });
  return directory;
}

export function writeOperationManifest(
  directory: string,
  manifest: CharacterResourceTransactionManifest,
): void {
  const target = path.join(directory, CHARACTER_RESOURCE_MANIFEST_NAME);
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  fs.renameSync(temporary, target);
}

export function readOperationManifest(
  directory: string,
): CharacterResourceTransactionManifest | null {
  try {
    const value = JSON.parse(
      fs.readFileSync(
        path.join(directory, CHARACTER_RESOURCE_MANIFEST_NAME),
        'utf8',
      ),
    ) as Partial<CharacterResourceTransactionManifest>;
    if (
      value.schemaVersion !== CHARACTER_RESOURCE_TRANSACTION_SCHEMA_VERSION
      || (value.type !== 'publish' && value.type !== 'delete')
      || typeof value.operationId !== 'string'
      || typeof value.characterId !== 'string'
      || !isResourceKind(value.resourceKind)
      || typeof value.resourceId !== 'string'
      || typeof value.relativePath !== 'string'
      || path.basename(directory) !== value.operationId
    ) {
      return null;
    }
    return value as CharacterResourceTransactionManifest;
  } catch {
    return null;
  }
}

export function moveWithoutOverwrite(source: string, destination: string): void {
  if (fs.existsSync(destination)) {
    throw new Error(`character resource destination already exists: ${destination}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(source, destination);
}

export function removeOperationDirectory(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true });
}

export function listOperationDirectories(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .map(entry => path.join(root, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function assertOperationId(value: string): void {
  if (!/^[0-9a-f-]{36}$/iu.test(value)) {
    throw new Error(`invalid character resource operation id: ${value}`);
  }
}

function isResourceKind(value: unknown): value is CharacterManagedResourceKind {
  return value === 'character'
    || value === 'live2d'
    || value === 'portrait'
    || value === 'voiceReference';
}
