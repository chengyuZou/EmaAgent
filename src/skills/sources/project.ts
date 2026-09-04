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

const MAX_DEPTH = 4;
const MAX_SKILL_DIRS = 2_000;

// TODO: 你这两趟扫不能优化下? o(2n) 我觉得可以优化为o(n) 此外不能开并发吗?
export async function scanProjectSkills(
  workspaceRoot: string,
): Promise<SkillDescriptor[]> {
  await realpath(workspaceRoot);
  const discovered = (await Promise.all(PROJECT_ECOSYSTEMS.map(async ecosystem => {
    const ecoRoot = join(workspaceRoot, ecosystem.relativeDir);
    const skillFiles = await collectSkillFiles(ecoRoot);
    return skillFiles.map(path => ({ path, ecosystem }));
  }))).flat().slice(0, MAX_SKILL_DIRS);

  const seenPaths = new Set<string>();
  const descriptors = await mapConcurrent(discovered, 16, async ({ path, ecosystem }) => {
      try {
        const canonicalPath = await realpath(path);
        if (seenPaths.has(canonicalPath)) return null;
        seenPaths.add(canonicalPath);
        const parsed = parseSkillMd(await readFile(canonicalPath, 'utf8'));
        return {
          name: parsed.name,
          path: canonicalPath,
          version: parsed.version,
          description: parsed.description,
          ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
          suggestedTools: parsed.suggestedTools,
          scope: 'project' as const,
          projectSourceId: ecosystem.sourceId,
        };
      } catch (error) {
        console.warn(`[skills] 项目技能损坏跳过: ${path}`, error);
        return null;
      }
  });
  return descriptors.flatMap(entry => entry ? [entry as SkillDescriptor] : []);
}

/** 在生态根下找 SKILL.md;dotfiles 不进,symlink 不跟随。 */
async function collectSkillFiles(
  ecoRoot: string,
): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || found.length >= MAX_SKILL_DIRS) return;
    let children;
    try {
      children = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const nested: Promise<void>[] = [];
    for (const child of children) {
      if (found.length >= MAX_SKILL_DIRS) return;
      if (child.name.startsWith('.')) continue;
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        nested.push(walk(join(dir, child.name), depth + 1));
      } else if (child.isFile() && child.name === 'SKILL.md') {
        found.push(join(dir, child.name));
      }
    }
    await Promise.all(nested);
  }
  await walk(ecoRoot, 1);
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
