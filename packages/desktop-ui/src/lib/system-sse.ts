/**
 * System SSE — subscribe to /api/system/events for global events.
 *
 * System bus carries: character_card_switched, provider_health_changed,
 * memory pipeline telemetry, background task events.
 *
 * NOT on the system bus (handled by per-turn SSE in conversation-store):
 *   permission_required / permission_resolved
 *   ask_user_required / ask_user_resolved
 *   emotion_changed / stage_cue
 *   tts_chunk / tts_sentence_complete
 *   memory_recall_evidence
 *   artifact_upserted / artifact_applied
 */
import { sseConsumer, type SseHandle } from './sse-consumer.js';
import { sidecarClient } from '../api/sidecar-client.js';
import { tauriBridge } from './tauri-bridge.js';
import { useSettingsStore } from '../stores/settings-store.js';
import { useCardStore } from '../stores/card-store.js';
import type { EmaStreamEvent } from '@ema-agent/contracts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SystemSseListener {
  onEvent(event: EmaStreamEvent): void;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _handle: SseHandle | null = null;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReconnect(delayMs: number): void {
  if (_reconnectTimer !== null) clearTimeout(_reconnectTimer);
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    void startSystemSse();
  }, delayMs);
}

/**
 * Start listening to /api/system/events.
 * Idempotent — second call is a no-op if already started.
 */
export async function startSystemSse(): Promise<void> {
  if (_handle) return;

  const [url, authHeaders] = await Promise.all([
    sidecarClient.streamUrl('/api/system/events'),
    sidecarClient.getAuthHeaders(),
  ]);

  _handle = sseConsumer.start({
    url,
    headers: authHeaders,
    onEvent: (event) => dispatchSystemEvent(event),
    onHeartbeat: () => {},
    onError: (err) => {
      console.error('[system-sse] error, will retry in 5s', err.message);
      _handle = null;
      scheduleReconnect(5000);
    },
    onComplete: () => {
      _handle = null;
      scheduleReconnect(3000);
    },
  });
}

/** Stop the system SSE subscription and cancel any pending reconnect. */
export function stopSystemSse(): void {
  if (_reconnectTimer !== null) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  if (_handle) {
    _handle.stop();
    _handle = null;
  }
}

// ── Event dispatcher ──────────────────────────────────────────────────────────

function dispatchSystemEvent(event: EmaStreamEvent): void {
  switch (event.type) {
    // ── Character card ─────────────────────────────────────────────────────
    case 'character_card_switched':
      void tauriBridge.emit('card:switched', { cardId: event.cardId, name: event.name });
      void useCardStore.getState().load();
      break;

    // ── Provider health ────────────────────────────────────────────────────
    case 'provider_health_changed':
      void useSettingsStore.getState().refreshProviders();
      break;

    // ── Memory observability ───────────────────────────────────────────────
    case 'memory_compaction_started':
    case 'memory_compaction_completed':
    case 'memory_compaction_failed':
    case 'memory_extraction_started':
    case 'memory_extraction_completed':
    case 'memory_extraction_failed':
    case 'memory_consolidation_started':
    case 'memory_consolidation_completed':
    case 'memory_consolidation_failed':
    case 'memory_maintenance_completed':
    case 'memory_maintenance_failed':
    case 'memory_node_merged':
    case 'memory_index_rebuilt':
    case 'memory_task_started':
    case 'memory_task_completed':
    case 'memory_task_failed':
      break;

    default:
      break;
  }
}
