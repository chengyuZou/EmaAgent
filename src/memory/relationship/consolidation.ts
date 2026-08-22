// 定义 Relationship 轨可读写的文件结构，并组装一次 Relationship 整合调用。

import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import type { CompleteExtraction } from '../common/extraction.js';
import {
  CONSOLIDATION_INPUT_INSTRUCTION,
  listMarkdownFiles,
  runConsolidationLlm,
  toPosixPath,
} from '../consolidation/consolidation.js';
import {
  DEFAULT_MEMORY_BUDGETS,
  type MemoryBudgets,
} from '../capacity/budgets.js';
import { loadTemplate } from '../templates/loader.js';
import type { ConsolidateMemory } from '../jobs/runConsolidationJobs.js';

// memory_summary.md 是注入源(Turn 启动时读一次,进持久化 reminder),整合器是唯一写者:
// 允许 write 是设计使然,但模板强制"基于正式记忆与本次证据重写",防自激。
const RELATIONSHIP_ROOT_FILES = [
  'shared_user_memory.md',
  'memory_summary.md',
  'character_relations.md',
] as const;

/** 枚举 Relationship 轨正式记忆文件（存在才列出；相对路径，posix）。 */
export function listRelationshipTargetPaths(
  memoryDirectory: string,
): readonly string[] {
  const targets: string[] = [];
  for (const name of RELATIONSHIP_ROOT_FILES) {
    if (existsSync(path.join(memoryDirectory, name))) targets.push(name);
  }
  // characters/<name>/MEMORY.md、history/*.md 和角色专属 notes。
  const charactersDir = path.join(memoryDirectory, 'characters');
  if (existsSync(charactersDir)) {
    for (const entry of readdirSync(charactersDir)) {
      const characterDir = path.join(charactersDir, entry);
      const memoryFile = path.join(characterDir, 'MEMORY.md');
      if (existsSync(memoryFile)) {
        targets.push(toPosixPath(path.relative(memoryDirectory, memoryFile)));
      }
      targets.push(
        ...listMarkdownFiles(memoryDirectory, path.join('characters', entry, 'history')),
      );
      targets.push(
        ...listMarkdownFiles(
          memoryDirectory,
          path.join('characters', entry, 'extensions', 'notes'),
        ),
      );
    }
  }
  targets.push(...listMarkdownFiles(memoryDirectory, path.join('extensions', 'notes')));
  return targets;
}

/** Relationship 允许为提取结果中的角色目录新建正式文件。 */
export function createRelationshipTargetPathCheck(
  memoryDirectory: string,
): (relativePath: string) => boolean {
  const currentPaths = listRelationshipTargetPaths(memoryDirectory);
  const existingNotes = new Set(
    currentPaths.filter((relativePath) => relativePath.includes('/notes/')),
  );
  return (relativePath) => {
    if (RELATIONSHIP_ROOT_FILES.some((name) => name === relativePath)) return true;
    if (existingNotes.has(relativePath)) return true;
    const segments = relativePath.split('/');
    if (segments.length === 3) {
      return segments[0] === 'characters'
        && isCharacterDirectoryName(memoryDirectory, segments[1]!)
        && segments[2] === 'MEMORY.md';
    }
    return segments.length === 4
      && segments[0] === 'characters'
      && isCharacterDirectoryName(memoryDirectory, segments[1]!)
      && segments[2] === 'history'
      && segments[3]!.endsWith('.md');
  };
}

/**
 * 角色目录必须已存在——角色目录由角色实体生命周期创建（characters 包/便签），
 * 整合器只能写已存在的角色，不能凭空创建新角色目录（对齐模板“不能发明角色目录”）。
 */
function isCharacterDirectoryName(memoryDirectory: string, value: string): boolean {
  return value.length > 0
    && value !== '.'
    && value !== '..'
    && existsSync(path.join(memoryDirectory, 'characters', value));
}

export interface RelationshipConsolidationDeps {
  /** 应用层的 LLM 调用闭包（两段消息 → 输出纯文本）。 */
  readonly complete: CompleteExtraction;
  /** 整合预算覆盖（可选）；缺省用内置默认。 */
  readonly budgets?: MemoryBudgets;
  /** 整合 system 模板覆盖（可选）；缺省用内置 md。 */
  readonly templates?: {
    readonly consolidationSystem?: string;
  };
}

/** 组装 runConsolidationJobs 需要的 Relationship consolidate 闭包。 */
export function createRelationshipConsolidate(
  deps: RelationshipConsolidationDeps,
): ConsolidateMemory {
  return async ({ memoryDirectory, diffFile, unintegrated, signal }) => {
    const systemTemplate = deps.templates?.consolidationSystem
      ?? await loadTemplate('relationshipConsolidation');
    return runConsolidationLlm({
      memoryDirectory,
      currentPaths: listRelationshipTargetPaths(memoryDirectory),
      isAllowedTargetPath: createRelationshipTargetPathCheck(memoryDirectory),
      diffFile,
      unintegrated,
      maxInputBytes:
        deps.budgets?.consolidationInputBytes
        ?? DEFAULT_MEMORY_BUDGETS.consolidationInputBytes,
      systemTemplate,
      inputTemplate: CONSOLIDATION_INPUT_INSTRUCTION,
      complete: deps.complete,
      signal,
    });
  };
}
