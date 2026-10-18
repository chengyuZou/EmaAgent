import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { CompleteMemoryLLM } from '../common/extraction.js';
import {
  CONSOLIDATION_INPUT_INSTRUCTION,
  listMarkdownFiles,
  runConsolidationLLM,
} from '../consolidation/consolidation.js';
import { MEMORY_CONSOLIDATION_INPUT_BYTES } from '../capacity/limits.js';
import { WORK_CONSOLIDATION_SYSTEM } from './prompt.js';
import type { ConsolidateMemory } from '../jobs/runConsolidationJobs.js';

// 摘要用于 Turn reminder. 整合 Prompt 要求从正式记忆与新证据重写,
// 避免旧摘要被反复当作新证据复制.
const WORK_ROOT_FILES = ['MEMORY.md', 'memory_summary.md'] as const;
const WORK_SUBDIRS = ['topics'] as const;

async function listWorkTargetPaths(
  memoryDirectory: string,
): Promise<readonly string[]> {
  const targets: string[] = [];
  for (const name of WORK_ROOT_FILES) {
    if (await isFile(path.join(memoryDirectory, name))) targets.push(name);
  }
  for (const subdir of WORK_SUBDIRS) {
    targets.push(...await listMarkdownFiles(memoryDirectory, subdir));
  }
  return targets;
}

function createWorkTargetPathCheck(): (relativePath: string) => boolean {
  return (relativePath) => (
    relativePath === 'MEMORY.md'
    || relativePath === 'memory_summary.md'
    || isMarkdownChild(relativePath, 'topics')
  );
}

export interface WorkConsolidationDeps {
  readonly complete: CompleteMemoryLLM;
}

export function createWorkConsolidate(
  deps: WorkConsolidationDeps,
): ConsolidateMemory {
  return async ({ memoryDirectory, diffFile, unintegrated, signal }) => {
    return runConsolidationLLM({
      memoryDirectory,
      currentPaths: await listWorkTargetPaths(memoryDirectory),
      isAllowedTargetPath: createWorkTargetPathCheck(),
      diffFile,
      unintegrated,
      maxInputBytes: MEMORY_CONSOLIDATION_INPUT_BYTES,
      systemTemplate: WORK_CONSOLIDATION_SYSTEM,
      inputTemplate: CONSOLIDATION_INPUT_INSTRUCTION,
      complete: deps.complete,
      signal,
    });
  };
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function isMarkdownChild(relativePath: string, directory: string): boolean {
  const segments = relativePath.split('/');
  return segments.length === 2
    && segments[0] === directory
    && segments[1]!.endsWith('.md');
}
