// 定义 Relationship 轨可读写的文件结构，并组装一次 Relationship 整合调用。

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { CompleteMemoryLlm } from '../common/extraction.js';
import {
  CONSOLIDATION_INPUT_INSTRUCTION,
  listMarkdownFiles,
  runConsolidationLlm,
  toPosixPath,
} from '../consolidation/consolidation.js';
import { MEMORY_CONSOLIDATION_INPUT_BYTES } from '../capacity/limits.js';
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
async function listRelationshipTargetPaths(
  memoryDirectory: string,
  characterNames: readonly string[],
): Promise<readonly string[]> {
  const targets: string[] = [];
  for (const name of RELATIONSHIP_ROOT_FILES) {
    if (await isFile(path.join(memoryDirectory, name))) targets.push(name);
  }
  for (const entry of characterNames) {
    const characterDir = path.join(memoryDirectory, 'characters', entry);
    const memoryFile = path.join(characterDir, 'MEMORY.md');
    if (await isFile(memoryFile)) {
      targets.push(toPosixPath(path.relative(memoryDirectory, memoryFile)));
    }
    targets.push(
      ...await listMarkdownFiles(memoryDirectory, path.join('characters', entry, 'history')),
    );
  }
  return targets;
}

/** Relationship 允许为提取结果中的角色目录新建正式文件。 */
export function createRelationshipTargetPathCheck(
  existingCharacterNames: readonly string[],
  extractedCharacterNames: readonly string[] = [],
): (relativePath: string) => boolean {
  const allowedCharacters = new Set([
    ...existingCharacterNames,
    ...extractedCharacterNames,
  ]);
  return (relativePath) => {
    if (RELATIONSHIP_ROOT_FILES.some((name) => name === relativePath)) return true;
    const segments = relativePath.split('/');
    if (segments.length === 3) {
      return segments[0] === 'characters'
        && isUsableCharacterSegment(segments[1]!)
        && allowedCharacters.has(segments[1]!)
        && segments[2] === 'MEMORY.md';
    }
    return segments.length === 4
      && segments[0] === 'characters'
      && isUsableCharacterSegment(segments[1]!)
      && allowedCharacters.has(segments[1]!)
      && segments[2] === 'history'
      && segments[3]!.endsWith('.md');
  };
}

export interface RelationshipConsolidationDeps {
  /** 应用层的 LLM 调用闭包（两段消息 → 输出纯文本）。 */
  readonly complete: CompleteMemoryLlm;
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
    const existingCharacterNames = await listCharacterNames(memoryDirectory);
    return runConsolidationLlm({
      memoryDirectory,
      currentPaths: await listRelationshipTargetPaths(
        memoryDirectory,
        existingCharacterNames,
      ),
      isAllowedTargetPath: createRelationshipTargetPathCheck(
        existingCharacterNames,
        unintegrated.flatMap(result => result.characterName ? [result.characterName] : []),
      ),
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

function isUsableCharacterSegment(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..';
}

async function listCharacterNames(memoryDirectory: string): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(memoryDirectory, 'characters'), { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
