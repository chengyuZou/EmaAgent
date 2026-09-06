// 定义 Work 轨可读写的文件结构，并组装一次 Work 整合调用。

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { CompleteMemoryLlm } from '../common/extraction.js';
import {
  CONSOLIDATION_INPUT_INSTRUCTION,
  listMarkdownFiles,
  runConsolidationLlm,
} from '../consolidation/consolidation.js';
import { MEMORY_CONSOLIDATION_INPUT_BYTES } from '../capacity/limits.js';
import { loadTemplate } from '../templates/loader.js';
import type { ConsolidateMemory } from '../jobs/runConsolidationJobs.js';

// memory_summary.md 是注入源(Turn 启动时读一次,进持久化 reminder),整合器是唯一写者:
// 允许 write 是设计使然,但模板强制"基于正式记忆与本次证据重写",防自激。
const WORK_ROOT_FILES = ['MEMORY.md', 'memory_summary.md'] as const;
const WORK_SUBDIRS = ['topics'] as const;

/** 枚举 Work 正式记忆。 */
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

/** Work 只允许维护根文件和 topics。 */
function createWorkTargetPathCheck(): (relativePath: string) => boolean {
  return (relativePath) => (
    relativePath === 'MEMORY.md'
    || relativePath === 'memory_summary.md'
    || isMarkdownChild(relativePath, 'topics')
  );
}

export interface WorkConsolidationDeps {
  /** 应用层的 LLM 调用闭包（两段消息 → 输出纯文本）。 */
  readonly complete: CompleteMemoryLlm;
  /** 整合 system 模板覆盖（可选）；缺省用内置 md。 */
  readonly templates?: {
    readonly consolidationSystem?: string;
  };
}

/** 组装 runConsolidationJobs 需要的 Work consolidate 闭包。 */
export function createWorkConsolidate(
  deps: WorkConsolidationDeps,
): ConsolidateMemory {
  return async ({ memoryDirectory, diffFile, unintegrated, signal }) => {
    const systemTemplate = deps.templates?.consolidationSystem
      ?? await loadTemplate('workConsolidation');
    return runConsolidationLlm({
      memoryDirectory,
      currentPaths: await listWorkTargetPaths(memoryDirectory),
      isAllowedTargetPath: createWorkTargetPathCheck(),
      diffFile,
      unintegrated,
      maxInputBytes: MEMORY_CONSOLIDATION_INPUT_BYTES,
      systemTemplate,
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
