// 把可用 Skill 目录贡献给 Prompt，并在模型调用 SkillCall 时加载完整内容。
import type { TurnMode } from '@ema-agent/contracts';
import type { PromptSlotContribution } from '@ema-agent/prompts';
import type { SkillStore } from './store.js';
import type { ActivatedSkill, SkillSummary } from './types.js';

// ── SkillRunner ───────────────────────────────────────────────────────────────
//
// 经 beforeLlm hook 向 system message 注入轻量"可用技能"CATALOG -
// 不是完整 body。模型选一个 skill 调 `SkillCall(skill, args)`;
// body 只在那时从磁盘懒读(见 SkillStore.renderBody)。这保持 prompt 小,
// 且因 catalog 只在 install/enable 时变(非 per-turn),保住 prompt cache。
//
// skill 不按模式门禁。catalog 只在 `agent` 模式注入,因 SkillCall 是
// agent 模式工具 - 没有 per-skill 模式标签。allowed-tools 由 SkillCall
// 交给 Agent capability scope 做交集收窄,不能授予权限。

export class SkillRunner {
  constructor(private readonly store: SkillStore) {}

  /** Turn 开始时冻结轻量 Skill Catalog，完整 Skill 正文仍按调用渐进披露。 */
  promptContribution(mode: TurnMode): PromptSlotContribution | null {
    if (mode !== 'agent') return null;
    const summaries = this.store.listSummaries();
    if (summaries.length === 0) return null;
    return {
      id: 'extension.skillCatalog',
      content: renderCatalog(summaries),
      version: 'skill-catalog-v1',
    };
  }

  /**
   * 激活一个 skill:从磁盘读其 body 并替换参数。
   * 经 apps/core 的 ISkillRunner adapter 接到 `SkillCall` 工具。
   */
  async activate(name: string, args: string | undefined): Promise<ActivatedSkill> {
    return this.store.activate(name, args);
  }

  /** 兼容管理端只渲染正文的调用。 */
  async render(name: string, args: string | undefined): Promise<string> {
    return (await this.activate(name, args)).content;
  }

}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

function renderCatalog(summaries: SkillSummary[]): string {
  const lines = summaries.map((s) => {
    const hint = s.argumentHint ? `  _(参数: ${s.argumentHint})_` : '';
    return `- **${s.name}**: ${s.description}${hint}`;
  });
  return (
    '## 可用技能\n' +
    '需要时用 `SkillCall(skill, args)` 激活以下技能(激活后才会注入其完整指令):\n' +
    lines.join('\n')
  );
}
