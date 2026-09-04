// 并发扫描宿主铺设的 builtin 技能目录并生成绝对路径描述符。
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
    const descriptors = await Promise.all((await listSkillDirectories(deps.builtinRoot)).map(async dir => {
      try {
        const skillFile = await resolveSkillFile(dir);
        const parsed = parseSkillMd(await readFile(skillFile, 'utf8'));
        return {
          name: parsed.name,
          path: skillFile,
          version: parsed.version,
          description: parsed.description,
          ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
          suggestedTools: parsed.suggestedTools,
          scope: 'builtin' as const,
        };
      } catch (error) {
        console.warn(`[skills] 内置技能损坏跳过: ${dir}`, error);
        return null;
      }
    }));
    return descriptors.flatMap(entry => entry ? [entry as SkillDescriptor] : []);
  } catch (error) {
    console.warn('[skills] builtin 扫描失败,降级为无内置技能:', error);
    return [];
  }
}
