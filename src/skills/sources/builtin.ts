// sources/builtin:内置技能扫描。
// 随包资源即事实源(release 打包带走),启动直接扫描;源缺失或损坏降级为空内置集,不阻塞启动。
import { readFile } from 'node:fs/promises';
import { parseSkillMd } from '../parser.js';
import { listSkillDirectories, resolveSkillFile } from '../paths.js';
import type { SkillDescriptor } from '../types.js';

export interface BuiltinScanDeps {
  /** 内置技能目录(发布资源,只读)。 */
  readonly builtinRoot: string;
}

export async function scanBuiltinSkills(deps: BuiltinScanDeps): Promise<SkillDescriptor[]> {
  try {
    const descriptors: SkillDescriptor[] = [];
    for (const dir of await listSkillDirectories(deps.builtinRoot)) {
      try {
        const skillFile = await resolveSkillFile(dir);
        const parsed = parseSkillMd(await readFile(skillFile, 'utf8'));
        const slug = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop()!;
        descriptors.push({
          key: `builtin:${slug}`,
          name: parsed.name,
          callName: parsed.name,
          version: parsed.version,
          description: parsed.description,
          ...(parsed.argumentHint !== undefined ? { argumentHint: parsed.argumentHint } : {}),
          ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
          allowedToolPatterns: parsed.allowedTools,
          rootPath: dir,
          scope: 'builtin',
        });
      } catch (error) {
        console.warn(`[skills] 内置技能损坏跳过: ${dir}`, error);
      }
    }
    return descriptors;
  } catch (error) {
    console.warn('[skills] builtin 扫描失败,降级为无内置技能:', error);
    return [];
  }
}
