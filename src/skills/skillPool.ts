// SkillPool:根 Turn 冻结的技能集合(镜像 ToolPool)。
// 冻结 = 取 Registry 当前全量 → 过滤禁用(逐技能 skill_enablement + project 来源级) →
// 排序 → path 索引。Pool 是本 Turn Prompt 目录与 SkillCall 查找的唯一事实源;
// Turn 内的安装/禁用变化只影响下一根 Turn。
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

/** 启用判定的输入：逐技能 deny 列表与 project 来源 deny 列表的当前值。 */
export type SkillEnablement = Omit<SkillPoolFreezeInput, 'entries'>;

const SCOPE_RANK: Record<SkillScope, number> = { builtin: 0, user: 1, project: 2 };

/** 单条启用判定：逐技能 deny → project 来源禁用；Pool 冻结与 UI 投影共用。 */
export function isSkillEnabled(entry: SkillDescriptor, input: SkillEnablement): boolean {
  if (input.disabledPaths.includes(entry.path)) return false;
  if (entry.scope === 'project') {
    if (entry.projectSourceId && input.disabledProjectSources.includes(entry.projectSourceId)) return false;
  }
  return true;
}

/** 根 Turn 冻结:deny 过滤 + 确定性排序 + path 索引。 */
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
 * Prompt 常驻目录:单遍截断,超出总预算即省略并计数提示;单条描述 ≤ 250 字符。
 * 只放 name/path/description/whenToUse;SKILL.md 全文由 SkillTool 返回。
 */
export function renderSkillListing(pool: SkillPool): string {
  const lines: string[] = [];
  let usedBytes = 0;
  let omitted = 0;

  for (const entry of pool.entries) {
    const description = entry.description.length > SKILL_LISTING_ENTRY_MAX_CHARS
      ? entry.description.slice(0, SKILL_LISTING_ENTRY_MAX_CHARS - 1) + '…'
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

  if (omitted > 0) lines.push(`…以及另外 ${omitted} 个技能(超出目录预算,未列出)`);
  return lines.join('\n');
}
