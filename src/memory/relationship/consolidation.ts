import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { CompleteMemoryLLM } from '../common/extraction.js';
import {
  CONSOLIDATION_INPUT_INSTRUCTION,
  listMarkdownFiles,
  runConsolidationLLM,
  toPosixPath,
} from '../consolidation/consolidation.js';
import { MEMORY_CONSOLIDATION_INPUT_BYTES } from '../capacity/limits.js';
import { RELATIONSHIP_CONSOLIDATION_SYSTEM } from './prompt.js';
import type { ConsolidateMemory } from '../jobs/runConsolidationJobs.js';

const RELATIONSHIP_ROOT_FILES = [
  'shared_user_memory.md',
  'character_relations.md',
] as const;

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

/** Relationship 允许为提取结果中的角色目录新建正式文件. */
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
  readonly complete: CompleteMemoryLLM;
}

export function createRelationshipConsolidate(
  deps: RelationshipConsolidationDeps,
): ConsolidateMemory {
  return async ({ memoryDirectory, diffFile, unintegrated, signal }) => {
    const existingCharacterNames = await listCharacterNames(memoryDirectory);
    return runConsolidationLLM({
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
      systemTemplate: RELATIONSHIP_CONSOLIDATION_SYSTEM,
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
