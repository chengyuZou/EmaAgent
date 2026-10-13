// 定义文件式 Memory 的固定目录结构.

import os from 'node:os';
import path from 'node:path';

export function memoryRootDir(): string {
  // 与 Desktop 和 Server 使用同一个应用数据目录, 隔离运行时不能读取默认目录里的真实记忆.
  const profileRoot = process.env['EMA_PROFILE_DIR'] ?? path.join(os.homedir(), '.ema-agent');
  return path.join(profileRoot, 'memories');
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
