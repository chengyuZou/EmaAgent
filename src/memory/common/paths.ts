// 定义文件式 Memory 的固定目录结构.

import os from 'node:os';
import path from 'node:path';

export function memoryRootDir(): string {
  return path.join(os.homedir(), '.ema-agent', 'memories');
}

export function workMemoryDir(): string {
  return path.join(memoryRootDir(), 'work');
}

export function relationshipMemoryDir(): string {
  return path.join(memoryRootDir(), 'relationship');
}

export function relationshipCharacterDir(
  characterDirectoryName: string,
): string {
  return path.join(
    relationshipMemoryDir(),
    'characters',
    characterDirectoryName,
  );
}

export function workMemoryNotesDir(): string {
  return path.join(workMemoryDir(), 'extensions', 'notes');
}

export function sharedRelationshipNotesDir(): string {
  return path.join(relationshipMemoryDir(), 'extensions', 'notes');
}

export function characterRelationshipNotesDir(
  characterDirectoryName: string,
): string {
  return path.join(
    relationshipCharacterDir(characterDirectoryName),
    'extensions',
    'notes',
  );
}

export function turnEvidenceDir(memoryDirectory: string): string {
  return path.join(memoryDirectory, 'turn_evidence');
}

export function memorySummaryFile(memoryDirectory: string): string {
  return path.join(memoryDirectory, 'memory_summary.md');
}

export function memoryFileSlug(value: string): string | undefined {
  const slug = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug.length === 0 ? undefined : slug;
}
