// 汇总业务事件订阅，并把角色切换等事实投递给进程内消费者与系统事件流。
import type { AppBindings } from './bindings.js';

// ── Aggregated emitter subscriptions ─────────────────────────────────────────

/**
 * Wire module-level emitters (not HookBus events) to their subscribers.
 *
 * Why a separate file from register-hooks.ts:
 *   HookBus  → "I run before X happens, may modify the payload, then continue"
 *   emitters → "I broadcast that X happened; subscribers react independently"
 *
 * Two destinations:
 *   1. In-process side-effects (emotion reset, stage reload, etc.)
 *   2. SystemEventBus — forwarded to /api/system/events for the bubble UI
 *
 * Returns an aggregate unregister function for tests / hot reload.
 */
export function registerAllEmitters(bindings: AppBindings): () => void {
  const offs: Array<() => void> = [];

  // ── Character card switched → reset per-card subsystems + broadcast ───────
  offs.push(
    bindings.card.onSwitched((next, _previous) => {
      // 1. In-process: emotion follows the active card's vocabulary
      bindings.emotion.updateVocabulary(next.emotionVocabulary);
      bindings.emotion.reset();

      // 2. Broadcast to frontend via system SSE
      bindings.systemBus.emit({
        type:   'character_card_switched',
        cardId: next.id,
        name:   next.name,
      });

      // 主窗口与 TTS 从角色聚合投影选择可用资源，不再读取角色卡旧单值字段。
    }),
  );

  return () => {
    for (const off of offs) {
      try { off(); } catch { /* tolerate */ }
    }
  };
}
