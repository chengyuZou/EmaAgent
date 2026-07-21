import { registerMemoryHooks }       from '@ema-agent/memory';
import type { AppBindings } from './bindings.js';

// ── Aggregated hook registration ─────────────────────────────────────────────

/**
 * 注册共享 HookBus 上真正的生命周期扩展。
 * Prompt、Skill、Memory Recall 与 Narrative Recall 已由 ContextAssembler 显式装配；
 * 当前只保留 Turn 完成后的长期记忆提取。
 */
export function registerAllHooks(bindings: AppBindings): () => void {
  const offs: Array<() => void> = [];

  // Recall 在 Turn 开始时直接生成 Context Contribution；这里只做 Turn 结束后的提取。
  offs.push(registerMemoryHooks(bindings.hooks, {
    planner:      bindings.memory,
    session:      bindings.session,
  }));

  return () => {
    for (const off of offs) {
      try { off(); } catch { /* tolerate idempotent unregister */ }
    }
  };
}
