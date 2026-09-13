// 在项目源文件夹的技能目录中限量扫描并解析 SKILL.md。
import { readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSkillMd } from '../parser.js';
import type { SkillDescriptor } from '../types.js';

/** 生态声明表:sourceId 只负责来源级启停。 */
export interface ProjectEcosystem {
  readonly sourceId: string;
  /** 工作区下的相对目录, 如 '.agents/skills'. */
  readonly relativeDir: string;
}

export const PROJECT_ECOSYSTEMS: readonly ProjectEcosystem[] = [
  { sourceId: 'agents', relativeDir: '.agents/skills' },
  { sourceId: 'claude', relativeDir: '.claude/skills' },
  { sourceId: 'codex', relativeDir: '.codex/skills' },
  { sourceId: 'cursor', relativeDir: '.cursor/skills' },
  { sourceId: 'gemini', relativeDir: '.gemini/skills' },
];

const MAX_DEPTH = 6;
const MAX_SKILL_DIRS_PER_ROOT = 2_000;
const FOLDER_SCAN_CONCURRENCY = 5;

export async function scanProjectSkills(
  folderPaths: readonly string[],
): Promise<SkillDescriptor[]> {
  const folders = await mapConcurrent(
    folderPaths,
    FOLDER_SCAN_CONCURRENCY,
    async (folderPath) => {
      try {
        await realpath(folderPath);
      } catch (error) {
        console.warn(`[skills] 项目文件夹不可读取: ${folderPath}`, error);
        return [];
      }
      const ecosystems = await Promise.all(PROJECT_ECOSYSTEMS.map(async (ecosystem) => {
        const ecoRoot = join(folderPath, ecosystem.relativeDir);
        const skillFiles = await collectSkillFiles(ecoRoot);
        return skillFiles.map(path => ({ path, ecosystem, folderPath }));
      }));
      return ecosystems.flat();
    },
  );
  const discovered = folders.flat();

  const seenPaths = new Set<string>();
  const descriptors = await mapConcurrent(discovered, 16, async ({
    path,
    ecosystem,
    folderPath,
  }) => {
    try {
      const canonicalPath = await realpath(path);
      if (seenPaths.has(canonicalPath)) return null;
      seenPaths.add(canonicalPath);
      const parsed = parseSkillMd(await readFile(canonicalPath, 'utf8'));
      return {
        name: parsed.name,
        path: canonicalPath,
        ...(parsed.version !== undefined ? { version: parsed.version } : {}),
        description: parsed.description,
        ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
        scope: 'project' as const,
        projectSourceId: ecosystem.sourceId,
        sourceFolderPath: folderPath,
      };
    } catch (error) {
      console.warn(`[skills] 项目技能损坏跳过: ${path}`, error);
      return null;
    }
  });
  return descriptors.flatMap(entry => entry ? [entry as SkillDescriptor] : []);
}

/** 在生态根下找 SKILL.md；目录上限按遍历过的目录计算，不按 Skill 文件数计算。 */
async function collectSkillFiles(
  ecoRoot: string,
): Promise<string[]> {
  const found: string[] = [];
  const queue: { path: string; depth: number }[] = [{ path: ecoRoot, depth: 0 }];
  let visitedDirs = 1;
  let truncated = false;

  for (let index = 0; index < queue.length; index += 1) {
    const { path: dir, depth } = queue[index]!;
    let children;
    try {
      children = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (child.name.startsWith('.')) continue;
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        if (depth >= MAX_DEPTH) continue;
        if (visitedDirs >= MAX_SKILL_DIRS_PER_ROOT) {
          truncated = true;
          continue;
        }
        queue.push({ path: join(dir, child.name), depth: depth + 1 });
        visitedDirs += 1;
      } else if (child.isFile() && child.name === 'SKILL.md') {
        found.push(join(dir, child.name));
      }
    }
  }
  if (truncated) {
    console.warn(`[skills] 目录扫描达到 ${MAX_SKILL_DIRS_PER_ROOT} 个上限: ${ecoRoot}`);
  }
  return found;
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  }));
  return results;
}
