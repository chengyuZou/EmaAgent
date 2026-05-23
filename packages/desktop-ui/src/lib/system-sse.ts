/**
 * System SSE — subscribe to /api/system/events for global events
 * (permission_required, emotion_changed, stage_cue, etc.).
 *
 * This is SEPARATE from the per-turn SSE stream in chat-store. System events
 * are broadcast to all windows, not scoped to a single turn.
 */
import { sseConsumer, type SseHandle } from './sse-consumer.js';
import { sidecarClient } from '../api/sidecar-client.js';
import { useDecisionStore } from '../stores/decision-store.js';
import type { EmaStreamEvent } from '@ema-agent/contracts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SystemSseListener {
  onEvent(event: EmaStreamEvent): void;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _handle: SseHandle | null = null;

/**
 * Start listening to /api/system/events.
 * Idempotent — second call is a no-op if already started.
 */
export async function startSystemSse(): Promise<void> {
  if (_handle) return;

  const url = await sidecarClient.streamUrl('/api/system/events');

  _handle = sseConsumer.start({
    url,
    onEvent: (event) => dispatchSystemEvent(event),
    onHeartbeat: () => {},
    onError: (err) => {
      console.error('[system-sse] error, will retry in 5s', err.message);
      _handle = null;
      setTimeout(() => { void startSystemSse(); }, 5000);
    },
    onComplete: () => {
      // System stream should never end; if it does, reconnect
      _handle = null;
      setTimeout(() => { void startSystemSse(); }, 3000);
    },
  });
}

/** Stop the system SSE subscription. */
export function stopSystemSse(): void {
  if (_handle) {
    _handle.stop();
    _handle = null;
  }
}

// ── Event dispatcher ──────────────────────────────────────────────────────────

function dispatchSystemEvent(event: EmaStreamEvent): void {
  switch (event.type) {
    // ── Decision prompts ───────────────────────────────────────────────────
    case 'permission_required':
      useDecisionStore.getState().push({
        kind:                     'permission',
        promptId:                 event.promptId,
        toolName:                 event.tool,
        args:                     event.args,
        hint:                     event.hint,
        humanDescription:         event.hint,      // backend doesn't produce humanDescription yet
        humanDescriptionPending:   false,
      });
      break;

    // ── Live2D / Stage ─────────────────────────────────────────────────────
    case 'emotion_changed':
    case 'stage_cue':
      // Dispatched by EmaStageView which has a direct import of live2d-react.
      // system-sse does NOT directly import live2d-react (avoids hard dep).
      break;

    // ── Context / memory — observed by ContextWindowPopover ────────────────
    case 'context_compacted':
    case 'recall_evidence':
      // These are also carried on turn SSE; system-level versions are ignored
      // for now — ContextWindowPopover reads from chat-store state.
      break;

    // ── Artifacts ──────────────────────────────────────────────────────────
    case 'artifact_upserted':
    case 'artifact_applied':
      // V1.5: push to artifact store
      break;

    // ── Turn lifecycle (system-level) — ignore, handled per-turn ──────────
    case 'turn_started':
    case 'turn_completed':
    case 'turn_failed':
    case 'turn_aborted':
      break;

    default:
      // Unknown events silently ignored
      break;
  }
}
