import type { HookBus, HookContext, HookResult } from '@ema-agent/hook';
import { PRIORITY } from '@ema-agent/hook';
import type { TurnMode } from '@ema-agent/contracts';
import type { SkillStore } from './store.js';
import type { SkillActivateMode, SkillSummary } from './types.js';

// ── SkillRunner ───────────────────────────────────────────────────────────────
//
// Injects a lightweight "available skills" CATALOG into the system message via
// the beforeLlm hook — NOT the full bodies. The model picks a skill and calls
// `skill_call(skill, arguments)`; the body is read lazily from disk only then
// (see SkillStore.renderBody). This keeps the prompt small and, because the
// catalog only changes on install/enable (not per-turn), preserves prompt cache.
//
// Activation rules:
//   - Skill is globally enabled (skills.enabled = 1)
//   - Skill.activates includes the current turn mode
//
// allowed-tools: enforced at activation time (skill_call → temp permission
// grant), not here. The runner only advertises availability.

export class SkillRunner {
  private unregister: (() => void) | null = null;

  constructor(
    private readonly store: SkillStore,
    private readonly hooks: HookBus,
  ) {}

  /** Register the beforeLlm hook. Call once at app startup. */
  start(): void {
    if (this.unregister) return;

    const handler = async (
      ctx: HookContext<'beforeLlm'>,
    ): Promise<HookResult<'beforeLlm'>> => {
      const mode = ctx.meta['mode'] as TurnMode | undefined;
      if (!mode) return { kind: 'continue' };

      const skillMode = turnModeToSkillMode(mode);
      if (!skillMode) return { kind: 'continue' };

      const summaries = this.store.listSummariesForMode(skillMode);
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
      };

      return { kind: 'replace', payload: { ...ctx.payload, messages: updated } };
    };

    this.unregister = this.hooks.register('beforeLlm', handler, {
      priority: PRIORITY.NORMAL,  // after memory recall (EARLY=20), before default handlers (DEFAULT=100)
      name:     'skill:inject-catalog',
      parallel: false,
    });
  }

  /**
   * Activate one skill: read its body from disk and substitute arguments.
   * Wired to the `skill_call` tool via the ISkillRunner adapter in apps/core.
   */
  async render(name: string, args: string | undefined): Promise<string> {
    return this.store.renderBody(name, args);
  }

  stop(): void {
    this.unregister?.();
    this.unregister = null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function turnModeToSkillMode(mode: TurnMode): SkillActivateMode | null {
  if (mode === 'chat')      return 'chat';
  if (mode === 'narrative') return 'narrative';
  if (mode === 'agent')     return 'agent';
  return null;
}
