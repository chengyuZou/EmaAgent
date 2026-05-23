/**
 * System SSE — subscribe to /api/system/events for global events
 * (permission_required, emotion_changed, stage_cue, etc.).
 *
 * This is SEPARATE from the per-turn SSE stream in chat-store. System events
 * are broadcast to all windows, not scoped to a single turn.
 */
import { sseConsumer, type SseHandle } from './sse-consumer.js';
import { sidecarClient } from '../api/sidecar-client.js';
import { tauriBridge } from './tauri-bridge.js';
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
        kind:                    'permission',
        promptId:                event.promptId,
        toolName:                event.tool,
        args:                    event.args,
        hint:                    event.hint,
        // Prefer the backend-generated humanDescription (tool-explainer LLM,
        // V1.5). Fall back to `hint` so the modal is never blank in V1.
        humanDescription:        event.humanDescription ?? event.hint,
        humanDescriptionPending: event.humanDescription === undefined,
      });
      break;

    case 'ask_user_required':
      useDecisionStore.getState().push({
        kind:             'ask_user',
        promptId:         event.promptId,
        questions:        event.questions,
        humanDescription: event.humanDescription,
      });
      break;

    case 'ask_user_resolved':
      // Backend confirms the answer arrived; if the modal is still showing
      // this promptId for any reason (e.g. timeout retry), clear it.
      useDecisionStore.getState().dismiss(event.promptId);
      break;

    // ── Live2D / Stage → forwarded via Tauri events to EmaStageView ──────
    case 'emotion_changed':
      void tauriBridge.emit('stage:emotion-changed', event.state);
      break;

    case 'stage_cue':
      void tauriBridge.emit('stage:cue', event.cue);
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
