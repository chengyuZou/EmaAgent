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
