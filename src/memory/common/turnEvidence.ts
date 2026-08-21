// 把 SQL 中的 Turn 事实同步为用户可查看的派生 Markdown.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { memoryFileSlug, turnEvidenceDir } from './paths.js';

export interface TurnEvidence {
  readonly sessionId: string;
  readonly turnId: string;
  readonly completedAt: Date;
  readonly title?: string;
  readonly content: string;
}

// TODO: 这里可能导致很多文件要写入但只取了 maxFiles 个
export async function syncTurnEvidence(
  memoryDirectory: string,
  evidence: readonly TurnEvidence[],
  maxFiles: number,
): Promise<void> {
  const directory = turnEvidenceDir(memoryDirectory);
  await fs.mkdir(directory, { recursive: true });

  const files = newestEvidence(evidence, maxFiles).map((item) => ({
    name: turnEvidenceFileName(item),
    content: renderTurnEvidence(item),
  }));
  const retainedNames = new Set(files.map((file) => file.name));

  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (
      entry.isFile()
      && entry.name.endsWith('.md')
      && !retainedNames.has(entry.name)
    ) {
      await fs.rm(path.join(directory, entry.name), { force: true });
    }
  }

  for (const file of files) {
    const filePath = path.join(directory, file.name);
    if (await readTextFile(filePath) !== file.content) {
      await fs.writeFile(filePath, file.content, 'utf8');
    }
  }
}

export function turnEvidenceFileName(evidence: TurnEvidence): string {
  const timestamp = evidence.completedAt
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19);
  const title = evidence.title === undefined
    ? undefined
    : memoryFileSlug(evidence.title);
  return title === undefined
    ? `${timestamp}-${evidence.turnId}.md`
    : `${timestamp}-${evidence.turnId}-${title}.md`;
}

export function renderTurnEvidence(evidence: TurnEvidence): string {
  return [
    `session_id: ${evidence.sessionId}`,
    `turn_id: ${evidence.turnId}`,
    `completed_at: ${evidence.completedAt.toISOString()}`,
    '',
    evidence.content.trim(),
    '',
  ].join('\n');
}

function newestEvidence(
  evidence: readonly TurnEvidence[],
  maxFiles: number,
): readonly TurnEvidence[] {
  return [...evidence]
    .sort((left, right) => {
      const timeOrder = right.completedAt.getTime() - left.completedAt.getTime();
      if (timeOrder !== 0) {
        return timeOrder;
      }
      return left.turnId.localeCompare(right.turnId);
    })
    .slice(0, Math.max(0, maxFiles));
}

async function readTextFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
