// 按每个角色真正出现过的活跃日期清理 Relationship 历史。

import { promises as fs } from 'node:fs';
import path from 'node:path';

interface RelationshipHistoryFile {
  readonly relativePath: string;
  readonly activeDate: string;
}

/**
 * 每个角色只保留最近 activeDays 个有历史记录的日期。
 * 用户离线不会产生日期，也就不会推进这条生命周期。
 */
export async function listExpiredRelationshipHistoryFiles(
  memoryRoot: string,
  activeDays: number,
): Promise<readonly string[]> {
  const files = await listRelationshipHistory(memoryRoot);
  const byCharacter = new Map<string, RelationshipHistoryFile[]>();

  for (const file of files) {
    const character = file.relativePath.split('/')[2];
    if (character === undefined) continue;
    const characterFiles = byCharacter.get(character) ?? [];
    characterFiles.push(file);
    byCharacter.set(character, characterFiles);
  }

  const expired: RelationshipHistoryFile[] = [];
  for (const characterFiles of byCharacter.values()) {
    const newestDates = [...new Set(characterFiles.map((file) => file.activeDate))]
      .sort((left, right) => right.localeCompare(left));
    const keptDates = new Set(newestDates.slice(0, activeDays));
    expired.push(...characterFiles.filter((file) => !keptDates.has(file.activeDate)));
  }

  return expired
    .sort(compareHistory)
    .map((file) => file.relativePath);
}

async function listRelationshipHistory(
  memoryRoot: string,
): Promise<readonly RelationshipHistoryFile[]> {
  const charactersDirectory = path.join(memoryRoot, 'relationship', 'characters');
  const characters = await readDirectories(charactersDirectory);
  const files: RelationshipHistoryFile[] = [];

  for (const character of characters) {
    const historyDirectory = path.join(charactersDirectory, character, 'history');
    let entries;
    try {
      entries = await fs.readdir(historyDirectory, { withFileTypes: true });
    } catch (error: unknown) {
      if (isMissing(error)) continue;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const activeDate = parseActiveDate(entry.name);
      if (activeDate === undefined) continue;
      files.push({
        relativePath: toPosix(path.join('relationship', 'characters', character, 'history', entry.name)),
        activeDate,
      });
    }
  }

  return files;
}

async function readDirectories(directory: string): Promise<readonly string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function parseActiveDate(fileName: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[._-].*)?\.md$/i.exec(fileName);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function compareHistory(
  left: RelationshipHistoryFile,
  right: RelationshipHistoryFile,
): number {
  return left.activeDate.localeCompare(right.activeDate)
    || left.relativePath.localeCompare(right.relativePath);
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
