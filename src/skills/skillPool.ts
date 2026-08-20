// SkillPool:根 Turn 冻结的技能集合(镜像 ToolPool)。
// 冻结 = 取 Registry 当前全量 → 过滤三个 deny → 排序 → callName 别名 → 现算 revision。
// Pool 是本 Turn Prompt 目录与 SkillCall 查找的唯一事实源;Turn 内的安装/禁用变化
// 只影响下一根 Turn。
import { createHash } from 'node:crypto';
import {
  SKILL_LISTING_BUDGET_BYTES,
  SKILL_LISTING_ENTRY_MAX_CHARS,
  type SkillDescriptor,
  type SkillKey,
  type SkillPool,
  type SkillScope,
} from './types.js';

export interface SkillPoolFreezeInput {
  readonly entries: readonly SkillDescriptor[];
  readonly disabledKeys: readonly string[];
  readonly disabledProjectSources: readonly string[];
  readonly builtinEnabled: boolean;
}

/** 启用判定的输入：三个 deny 开关的当前值。 */
export type SkillEnablement = Omit<SkillPoolFreezeInput, 'entries'>;

const SCOPE_RANK: Record<SkillScope, number> = { builtin: 0, user: 1, project: 2 };

/** 单条启用判定：denyKeys → builtin 总开关 → project 来源禁用；Pool 冻结与 UI 投影共用。 */
export function isSkillEnabled(entry: SkillDescriptor, input: SkillEnablement): boolean {
  if (input.disabledKeys.includes(entry.key)) return false;
  if (entry.scope === 'builtin' && !input.builtinEnabled) return false;
  if (entry.scope === 'project') {
    const sourceId = projectSourceId(entry.key);
    if (sourceId !== null && input.disabledProjectSources.includes(sourceId)) return false;
  }
  return true;
}

/** 根 Turn 冻结:deny 过滤 + 确定性排序 + callName 别名 + revision。 */
export function freezeSkillPool(input: SkillPoolFreezeInput): SkillPool {
  const visible = input.entries.filter((entry) => isSkillEnabled(entry, input));

  const sorted = [...visible].sort((left, right) =>
    SCOPE_RANK[left.scope] - SCOPE_RANK[right.scope]
    || left.callName.localeCompare(right.callName),
  );

  // callName 冲突:排序序首个保留原名,后续追加 __<scope>_<序号>,结果稳定。
  const counts = new Map<string, number>();
  for (const entry of sorted) counts.set(entry.callName, (counts.get(entry.callName) ?? 0) + 1);
  const seen = new Map<string, number>();
  const entries = sorted.map((entry) => {
    if (counts.get(entry.callName) === 1) return entry;
    const index = seen.get(entry.callName) ?? 0;
    seen.set(entry.callName, index + 1);
    if (index === 0) return entry;
    return { ...entry, callName: `${entry.callName}__${entry.scope}_${index}` };
  });

  const byKey = new Map<SkillKey, SkillDescriptor>();
  const byCallName = new Map<string, SkillDescriptor>();
  for (const entry of entries) {
    byKey.set(entry.key, entry);
    byCallName.set(entry.callName, entry);
  }

  return Object.freeze({
    revision: computeRevision(entries),
    entries: Object.freeze(entries) as readonly SkillDescriptor[],
    getByKey: (key: SkillKey) => byKey.get(key),
    getByCallName: (name: string) => byCallName.get(name),
  });
}

/** revision = 有序 (key, version, description, whenToUse) 的稳定哈希;输入不变则字节不变。 */
function computeRevision(entries: readonly SkillDescriptor[]): string {
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.key);
    hash.update(' ');
    hash.update(entry.version);
    hash.update(' ');
    hash.update(entry.description);
    hash.update(' ');
    hash.update(entry.whenToUse ?? '');
    hash.update('\n');
  }
  return hash.digest('hex').slice(0, 16);
}

/** project key 的来源 id:project:<sourceId>:<workspaceRelPath>。 */
function projectSourceId(key: SkillKey): string | null {
  if (!key.startsWith('project:')) return null;
  const rest = key.slice('project:'.length);
  const sep = rest.indexOf(':');
  return sep > 0 ? rest.slice(0, sep) : null;
}

/**
 * Prompt 常驻目录:单遍截断,超出总预算即省略并计数提示;单条描述 ≤ 250 字符。
 * 只放 name/description/whenToUse/argumentHint——SKILL.md 全文由 SkillCall 返回。
 */
export function renderSkillListing(pool: SkillPool): string {
  const lines: string[] = [];
  let usedBytes = 0;
  let omitted = 0;

  for (const entry of pool.entries) {
    const description = entry.description.length > SKILL_LISTING_ENTRY_MAX_CHARS
      ? entry.description.slice(0, SKILL_LISTING_ENTRY_MAX_CHARS - 1) + '…'
      : entry.description;
    const parts = [`- ${entry.callName}: ${description}`];
    if (entry.whenToUse) parts.push(`  when: ${entry.whenToUse}`);
    if (entry.argumentHint) parts.push(`  args: ${entry.argumentHint}`);
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
