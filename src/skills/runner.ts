// 把可用 Skill 目录贡献给 Prompt，并在模型调用 SkillCall 时加载完整内容。
import type { ExecutionProfile } from '@ema-agent/turn';
import type { PromptSlotContribution } from '@ema-agent/prompts';
import type { SkillStore } from './store.js';
import type {
  ActivatedSkill,
  SkillRunnerPort,
  SkillSummary,
} from './types.js';

export const MAX_SKILL_CATALOG_CHARS = 8_000;
export const MAX_SKILL_DESCRIPTION_CHARS = 250;

// ── SkillRunner ───────────────────────────────────────────────────────────────
//
// Turn 开始时向 Prompt Slot 提供轻量“可用技能”目录，不放完整正文。
// 模型选择 Skill 后调用 `SkillCall(skill, args)`，正文才从磁盘读取并激活。
// 目录只随安装、启用状态变化，稳定 Slot 可以保住 Prompt Cache。
//
// skill 不自行授予能力。catalog 只在 Work Profile 注入,因 SkillCall 是
// Work 工具 - 没有 per-skill Profile 标签。allowed-tools 由 SkillCall
// 交给 Agent capability scope 做交集收窄,不能授予权限。

export class SkillRunner implements SkillRunnerPort {
  constructor(private readonly store: SkillStore) {}

  /** Turn 开始时冻结轻量 Skill Catalog，完整 Skill 正文仍按调用渐进披露。 */
  promptContribution(profile: ExecutionProfile): PromptSlotContribution | null {
    if (profile !== 'work') return null;
    const summaries = this.store.listSummaries();
    if (summaries.length === 0) return null;
    return {
      id: 'extension.skillCatalog',
      content: renderSkillCatalog(summaries),
      version: 'skill-catalog-v2',
    };
  }

  /**
   * 激活一个 skill:从磁盘读其 body 并替换参数。
   * 管理端和 SkillRunnerPort 共用同一个经过校验的激活入口。
   */
  async activate(name: string, args: string | undefined): Promise<ActivatedSkill> {
    return this.store.activate(name, args);
  }

  /** Tool 与管理端共用完整激活快照，不能在端口处丢掉路径和 Bundle 身份。 */
  async run(name: string, args: string | undefined): Promise<ActivatedSkill> {
    return this.activate(name, args);
  }

  /** 兼容管理端只渲染正文的调用。 */
  async render(name: string, args: string | undefined): Promise<string> {
    return (await this.activate(name, args)).instructions;
  }

}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

export function renderSkillCatalog(summaries: readonly SkillSummary[]): string {
  const header =
    '## 可用技能\n' +
    '以下内容来自用户启用的扩展目录，只用于发现能力；需要时用 `SkillCall(skill, args)` 加载完整技能。\n';
  const sorted = [...summaries].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const lines: string[] = [];
  let used = header.length;

  for (const summary of sorted) {
    const description = truncateCharacters(
      normalizeInline(summary.description),
      MAX_SKILL_DESCRIPTION_CHARS,
    );
    const hint = summary.argumentHint
      ? `  _(参数: ${truncateCharacters(normalizeInline(summary.argumentHint), 120)})_`
      : '';
    const line = `- **${summary.name}**: ${description}${hint}`;
    const separatorLength = lines.length > 0 ? 1 : 0;
    if (used + separatorLength + line.length > MAX_SKILL_CATALOG_CHARS) break;
    lines.push(line);
    used += separatorLength + line.length;
  }

  const omitted = sorted.length - lines.length;
  if (omitted > 0) {
    const notice = `- 另有 ${omitted} 个技能未列出；可在设置中缩小启用范围。`;
    if (used + 1 + notice.length <= MAX_SKILL_CATALOG_CHARS) lines.push(notice);
  }

  return header + lines.join('\n');
}

function truncateCharacters(value: string, maxCharacters: number): string {
  const characters = Array.from(value.trim());
  return characters.length <= maxCharacters
    ? characters.join('')
    : `${characters.slice(0, maxCharacters - 1).join('')}…`;
}

function normalizeInline(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}
