import {
  SKILL_LISTING_BUDGET_BYTES,
  SKILL_LISTING_ENTRY_MAX_CHARS,
  type SkillDescriptor,
  type SkillPool,
  type SkillScope,
} from './types.js';

export interface SkillPoolFreezeInput {
  readonly entries: readonly SkillDescriptor[];
  readonly disabledPaths: readonly string[];
  readonly disabledProjectSources: readonly string[];
}

/** builtin/user 的禁用路径, 以及 project 的禁用来源. */
export type SkillEnablement = Omit<SkillPoolFreezeInput, 'entries'>;

const SCOPE_RANK: Record<SkillScope, number> = { builtin: 0, user: 1, project: 2 };

/** Turn 准备和设置列表共用此判定, 避免展示状态与实际启用状态不同. */
export function isSkillEnabled(entry: SkillDescriptor, input: SkillEnablement): boolean {
  if (input.disabledPaths.includes(entry.path)) return false;
  if (entry.scope === 'project') {
    if (entry.projectSourceId && input.disabledProjectSources.includes(entry.projectSourceId)) return false;
  }
  return true;
}

/** 过滤禁用项后按作用域, 名称, 路径排序. 后续启停或安装在下一 Turn 生效. */
export function freezeSkillPool(input: SkillPoolFreezeInput): SkillPool {
  const visible = input.entries.filter((entry) => isSkillEnabled(entry, input));

  const sorted = [...visible].sort((left, right) =>
    SCOPE_RANK[left.scope] - SCOPE_RANK[right.scope]
    || left.name.localeCompare(right.name)
    || left.path.localeCompare(right.path),
  );
  const entries = sorted;
  const byPath = new Map(entries.map(entry => [entry.path, entry]));

  return Object.freeze({
    entries: Object.freeze(entries) as readonly SkillDescriptor[],
    getByPath: (path: string) => byPath.get(path),
  });
}

/**
 * Prompt 只放名称, 路径, 描述和使用条件, 正文由 Skill 工具读取.
 * 描述最多 250 个 UTF-16 码元; 超出条目预算时省略该条, 最后追加省略数量.
 */
export function renderSkillListing(pool: SkillPool): string {
  const lines: string[] = [];
  let usedBytes = 0;
  let omitted = 0;

  for (const entry of pool.entries) {
    const description = entry.description.length > SKILL_LISTING_ENTRY_MAX_CHARS
      ? entry.description.slice(0, SKILL_LISTING_ENTRY_MAX_CHARS - 3) + '...'
      : entry.description;
    const parts = [`- ${entry.name} (${entry.path}): ${description}`];
    if (entry.whenToUse) parts.push(`  when: ${entry.whenToUse}`);
    const line = parts.join('\n');
    const bytes = Buffer.byteLength(line, 'utf8');
    if (usedBytes + bytes > SKILL_LISTING_BUDGET_BYTES) {
      omitted += 1;
      continue;
    }
    usedBytes += bytes;
    lines.push(line);
  }

  if (omitted > 0) lines.push(`...以及另外 ${omitted} 个技能(超出目录预算, 未列出)`);
  return lines.join('\n');
}
