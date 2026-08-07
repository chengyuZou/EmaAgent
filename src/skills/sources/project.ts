// sources/project:工作区生态目录扫描(原位只读,不复制、不进 SQL)。
// 扫描边界(架构 v4 §8):每生态根深 ≤ 4、每根 ≤ 2000 个技能目录、跳过 dotfiles、
// gitignore 目录不进(node_modules 等防依赖包投毒)、symlink 不跟随、realpath 去重。
import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSkillMd, readSkillFileBounded } from '../parser.js';
import type { SkillDescriptor } from '../types.js';

/** 生态声明表:sourceId 即 project key 的来源段(project:<sourceId>:<relPath>)。 */
export interface ProjectEcosystem {
  readonly sourceId: string;
  /** 工作区下的相对目录,如 '.agents/skills'。 */
  readonly relativeDir: string;
}

export const PROJECT_ECOSYSTEMS: readonly ProjectEcosystem[] = [
  { sourceId: 'agents',  relativeDir: '.agents/skills' },
  { sourceId: 'claude',  relativeDir: '.claude/skills' },
  { sourceId: 'codex',   relativeDir: '.codex/skills' },
  { sourceId: 'cursor',  relativeDir: '.cursor/skills' },
  { sourceId: 'gemini',  relativeDir: '.gemini/skills' },
];

export interface ProjectScanOptions {
  /** gitignore 判定:返回 true 表示该工作区相对路径被忽略,不得扫描。 */
  readonly isIgnored?: (workspaceRelPath: string) => boolean;
}

const MAX_DEPTH = 4;
const MAX_SKILL_DIRS = 2_000;

export async function scanProjectSkills(
  workspaceRoot: string,
  options: ProjectScanOptions = {},
): Promise<SkillDescriptor[]> {
  const descriptors: SkillDescriptor[] = [];
  const seenRealDirs = new Set<string>();
  let visited = 0;

  for (const ecosystem of PROJECT_ECOSYSTEMS) {
    if (visited >= MAX_SKILL_DIRS) break;
    const ecoRoot = join(workspaceRoot, ecosystem.relativeDir);
    const skillFiles = await collectSkillFiles(ecoRoot, ecosystem.relativeDir, options);
    for (const skillFile of skillFiles) {
      if (visited >= MAX_SKILL_DIRS) break;
      const dir = skillFile.slice(0, skillFile.length - '/SKILL.md'.length);
      try {
        const canonical = await realpath(dir);
        if (seenRealDirs.has(canonical)) continue;
        seenRealDirs.add(canonical);

        const manifest = parseSkillMd(await readSkillFileBounded(skillFile));
        const relPath = toPosix(canonical.startsWith(workspaceRoot)
          ? canonical.slice(workspaceRoot.length).replace(/^[/\\]+/, '')
          : dir);
        descriptors.push({
          key: `project:${ecosystem.sourceId}:${relPath}`,
          name: manifest.name,
          callName: manifest.name,
          version: manifest.version,
          description: manifest.description,
          ...(manifest.argumentHint !== undefined ? { argumentHint: manifest.argumentHint } : {}),
          ...(manifest.whenToUse !== undefined ? { whenToUse: manifest.whenToUse } : {}),
          allowedToolPatterns: manifest.allowedTools,
          rootPath: dir,
          scope: 'project',
        });
        visited += 1;
      } catch (error) {
        console.warn(`[skills] 项目技能损坏跳过: ${dir}`, error);
      }
    }
  }
  return descriptors;
}

/** 在生态根下找 SKILL.md;dotfiles 与 isIgnored 命中不进,symlink 不跟随。 */
async function collectSkillFiles(
  ecoRoot: string,
  ecoRelDir: string,
  options: ProjectScanOptions,
): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, relDir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || found.length >= MAX_SKILL_DIRS) return;
    let children;
    try {
      children = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (found.length >= MAX_SKILL_DIRS) return;
      if (child.name.startsWith('.')) continue;
      const childRel = `${relDir}/${child.name}`;
      if (options.isIgnored?.(childRel)) continue;
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        await walk(join(dir, child.name), childRel, depth + 1);
      } else if (child.isFile() && child.name === 'SKILL.md') {
        found.push(join(dir, child.name));
      }
    }
  }
  await walk(ecoRoot, ecoRelDir, 1);
  return found;
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}
