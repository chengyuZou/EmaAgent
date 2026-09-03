// 定义 Work 轨可读写的文件结构，并组装一次 Work 整合调用。

import path from 'node:path';
import { existsSync } from 'node:fs';
import type { CompleteExtraction } from '../common/extraction.js';
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
const WORK_SUBDIRS = ['topics', 'history'] as const;

/** 枚举当前存在的正式记忆和待整合便签。 */
export function listWorkTargetPaths(
  memoryDirectory: string,
): readonly string[] {
  const targets: string[] = [];
  for (const name of WORK_ROOT_FILES) {
    if (existsSync(path.join(memoryDirectory, name))) targets.push(name);
  }
  for (const subdir of WORK_SUBDIRS) {
    targets.push(...listMarkdownFiles(memoryDirectory, subdir));
  }
  targets.push(...listMarkdownFiles(memoryDirectory, path.join('extensions', 'notes')));
  return targets;
}

/** Work 可以新建正式文件；便签只能删除或更新本轮已经存在的文件。 */
export function createWorkTargetPathCheck(
  memoryDirectory: string,
): (relativePath: string) => boolean {
  const existingNotes = new Set(
    listMarkdownFiles(memoryDirectory, path.join('extensions', 'notes')),
  );
  return (relativePath) => (
    relativePath === 'MEMORY.md'
    || relativePath === 'memory_summary.md'
    || isMarkdownChild(relativePath, 'topics')
    || isMarkdownChild(relativePath, 'history')
    || existingNotes.has(relativePath)
  );
}

export interface WorkConsolidationDeps {
  /** 应用层的 LLM 调用闭包（两段消息 → 输出纯文本）。 */
  readonly complete: CompleteExtraction;
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
      currentPaths: listWorkTargetPaths(memoryDirectory),
      isAllowedTargetPath: createWorkTargetPathCheck(memoryDirectory),
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

function isMarkdownChild(relativePath: string, directory: string): boolean {
  const segments = relativePath.split('/');
  return segments.length === 2
    && segments[0] === directory
    && segments[1]!.endsWith('.md');
}
