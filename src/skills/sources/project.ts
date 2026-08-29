// sources/project:工作区生态目录扫描(原位只读,不复制、不进 SQL)。
// 扫描边界:每生态根深 ≤ 4、每根 ≤ 2000 个技能目录、跳过 dotfiles、
// symlink 不跟随、realpath 去重;过滤由 Settings 三个 deny 开关承担。
import { readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSkillMd } from '../parser.js';
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

const MAX_DEPTH = 4;
const MAX_SKILL_DIRS = 2_000;

export async function scanProjectSkills(
  workspaceRoot: string,
): Promise<SkillDescriptor[]> {
  const descriptors: SkillDescriptor[] = [];
  const seenRealDirs = new Set<string>();
  let visited = 0;
  // workspaceRoot 先 canonicalize:realpath 返回真实大小写,否则 Windows 上
  // 传入路径与 realpath 大小写不一致时前缀比较失败,绝对路径会漏进 SkillKey。
  const canonicalRoot = toPosix(await realpath(workspaceRoot));

  for (const ecosystem of PROJECT_ECOSYSTEMS) {
    if (visited >= MAX_SKILL_DIRS) break;
    const ecoRoot = join(workspaceRoot, ecosystem.relativeDir);
    const skillFiles = await collectSkillFiles(ecoRoot, ecosystem.relativeDir);
    for (const skillFile of skillFiles) {
      if (visited >= MAX_SKILL_DIRS) break;
      const dir = skillFile.slice(0, skillFile.length - '/SKILL.md'.length);
      try {
        const canonical = toPosix(await realpath(dir));
        if (seenRealDirs.has(canonical)) continue;
        seenRealDirs.add(canonical);

        const parsed = parseSkillMd(await readFile(skillFile, 'utf8'));
        const relPath = canonical.startsWith(canonicalRoot)
          ? canonical.slice(canonicalRoot.length).replace(/^\/+/, '')
          : canonical;
        descriptors.push({
          key: `project:${ecosystem.sourceId}:${relPath}`,
          name: parsed.name,
          callName: parsed.name,
          version: parsed.version,
          description: parsed.description,
          ...(parsed.argumentHint !== undefined ? { argumentHint: parsed.argumentHint } : {}),
          ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
          allowedToolPatterns: parsed.allowedTools,
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

/** 在生态根下找 SKILL.md;dotfiles 不进,symlink 不跟随。 */
async function collectSkillFiles(
  ecoRoot: string,
  ecoRelDir: string,
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
