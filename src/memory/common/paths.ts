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
  characterName: string,
): string {
  return path.join(
    relationshipMemoryDir(),
    'characters',
    characterName,
  );
}

export function memorySummaryFile(memoryDirectory: string): string {
  return path.join(memoryDirectory, 'memory_summary.md');
}
