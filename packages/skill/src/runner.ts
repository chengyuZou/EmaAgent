import type { HookBus, HookContext, HookResult } from '@ema-agent/hook';
import { PRIORITY } from '@ema-agent/hook';
import type { TurnMode } from '@ema-agent/contracts';
import type { SkillStore } from './store.js';
import type { SkillActivateMode } from './types.js';

// ── SkillRunner ───────────────────────────────────────────────────────────────
//
// Injects active skill prompts into the system message via the beforeLlm hook.
//
// Activation rules:
//   - Skill is globally enabled (skills.enabled = 1)
//   - Skill.activates includes the current turn mode
//
// Injection: skill bodies are appended to the system message AFTER the role-card
// system prompt (lower hook priority). Each skill is separated by a divider so
// the LLM can distinguish them.
//
// B (allowed-tools): We intentionally do NOT modify PermissionEngine rules here.
// Skill's allowed-tools field is informational in V1 — it tells the user what
// the skill needs but does not auto-grant permissions. Full B support (runtime
// permission injection + cleanup) is deferred to V1.5.

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

      const skills = this.store.listActiveForMode(skillMode);
      if (skills.length === 0) return { kind: 'continue' };

      // Append each skill body to the system message
      const messages = ctx.payload.messages;
      const systemIdx = messages.findIndex((m) => m.role === 'system');
      if (systemIdx < 0) return { kind: 'continue' };

      const additions = skills
        .filter((s) => s.manifest.body.length > 0)
        .map((s) => `\n\n---\n<!-- skill:${s.manifest.name} -->\n${s.manifest.body}`)
        .join('');

      if (!additions) return { kind: 'continue' };

      const updated = [...messages];
      const sys = updated[systemIdx]!;
      updated[systemIdx] = {
        role:    'system',
        content: (typeof sys.content === 'string' ? sys.content : '') + additions,
      };

      return { kind: 'replace', payload: { ...ctx.payload, messages: updated } };
    };

    this.unregister = this.hooks.register('beforeLlm', handler, {
      priority: PRIORITY.NORMAL,  // after memory recall (EARLY=20), before default handlers (DEFAULT=100)
      name:     'skill:inject-prompts',
      parallel: false,
    });
  }

  stop(): void {
    this.unregister?.();
    this.unregister = null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function turnModeToSkillMode(mode: TurnMode): SkillActivateMode | null {
  if (mode === 'chat')      return 'chat';
  if (mode === 'narrative') return 'narrative';
  if (mode === 'agent')     return 'agent';
  return null;
}
