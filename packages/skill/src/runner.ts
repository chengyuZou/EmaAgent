import type { HookBus, HookContext, HookResult } from '@ema-agent/hook';
import { PRIORITY } from '@ema-agent/hook';
import type { SkillStore } from './store.js';
import type { SkillSummary } from './types.js';

// ── SkillRunner ───────────────────────────────────────────────────────────────
//
// 经 beforeLlm hook 向 system message 注入轻量"可用技能"CATALOG -
// 不是完整 body。模型选一个 skill 调 `skill_call(skill, arguments)`;
// body 只在那时从磁盘懒读(见 SkillStore.renderBody)。这保持 prompt 小,
// 且因 catalog 只在 install/enable 时变(非 per-turn),保住 prompt cache。
//
// skill 不按模式门禁。catalog 只在 `agent` 模式注入,因 skill_call 是
// agent 模式工具 - 没有 per-skill 模式标签。allowed-tools 在激活时强制
// (skill_call -> 临时权限授予),不在这里;runner 只广播可用性。

export class SkillRunner {
  private unregister: (() => void) | null = null;

  constructor(
    private readonly store: SkillStore,
    private readonly hooks: HookBus,
  ) {}

  /** 注册 beforeLlm hook。应用启动时调一次。 */
  start(): void {
    if (this.unregister) return;

    const handler = async (
      ctx: HookContext<'beforeLlm'>,
    ): Promise<HookResult<'beforeLlm'>> => {
      const mode = ctx.payload.mode;
      // skill_call 是 agent 模式工具;在别处广播 skill 是死重
      // (模型无法调用)。
      if (mode !== 'agent') return { kind: 'continue' };

      const summaries = this.store.listSummaries();
      if (summaries.length === 0) return { kind: 'continue' };

      const messages = ctx.payload.messages;
      const systemIdx = messages.findIndex((m) => m.role === 'system');
      if (systemIdx < 0) return { kind: 'continue' };

      const catalog = renderCatalog(summaries);
      const updated = [...messages];
      const sys = updated[systemIdx]!;
      updated[systemIdx] = {
        role:    'system',
        content: (typeof sys.content === 'string' ? sys.content : '') + catalog,
        ...(sys.cacheBreakpoint ? { cacheBreakpoint: true as const } : {}),
      };

      return { kind: 'replace', payload: { ...ctx.payload, messages: updated } };
    };

    this.unregister = this.hooks.register('beforeLlm', handler, {
      priority: PRIORITY.NORMAL,  // 在 memory recall(EARLY=20)后,默认 handler(DEFAULT=100)前
      name:     'skill:inject-catalog',
      parallel: false,
    });
  }

  /**
   * 激活一个 skill:从磁盘读其 body 并替换参数。
   * 经 apps/core 的 ISkillRunner adapter 接到 `skill_call` 工具。
   */
  async render(name: string, args: string | undefined): Promise<string> {
    return this.store.renderBody(name, args);
  }

  stop(): void {
    this.unregister?.();
    this.unregister = null;
  }
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

function renderCatalog(summaries: SkillSummary[]): string {
  const lines = summaries.map((s) => {
    const hint = s.argumentHint ? `  _(参数: ${s.argumentHint})_` : '';
    return `- **${s.name}**: ${s.description}${hint}`;
  });
  return (
    '\n\n---\n## 可用技能\n' +
    '需要时用 `skill_call(skill, arguments)` 激活以下技能(激活后才会注入其完整指令):\n' +
    lines.join('\n')
  );
}
