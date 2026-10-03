// 根 Turn 与手动 Compact 共用的 SkillPool 准备: 读取目录并应用禁用设置.
import type { SettingsStore } from '@ema-agent/settings';
import {
  disabledProjectSourcesSetting,
  freezeSkillPool,
  type SkillDescriptor,
  type SkillPool,
} from '@ema-agent/skills';

export interface SkillPoolDeps {
  readonly settings: SettingsStore;
  /** SkillRegistry 当前全量条目(含工作区的 project 技能) */
  readonly skillEntries: (
    cwd: string,
    projectId: string | null,
  ) => Promise<readonly SkillDescriptor[]>;
  /** SkillStore 从 skills.enabled 读取的当前禁用路径. */
  readonly disabledSkillPaths: () => readonly string[];
}

/** Chat 与 Work 使用同一份冻结的 Skill 目录 */
export async function resolveSkillPool(
  deps: SkillPoolDeps,
  cwd: string,
  projectId: string | null,
): Promise<SkillPool | undefined> {
  const skillEntries = await deps.skillEntries(cwd, projectId);
  if (skillEntries.length === 0) return undefined;
  return freezeSkillPool({
    entries: skillEntries,
    disabledPaths: deps.disabledSkillPaths(),
    disabledProjectSources: deps.settings.get(disabledProjectSourcesSetting).disabledSourceIds,
  });
}
