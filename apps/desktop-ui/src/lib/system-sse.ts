/**
 * 订阅全局系统 SSE，并把后台业务事件分发到对应前端 Store。
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
 *   memory_compaction_started / completed / failed / skipped ← emitted via ctx.emit (beforeLlm), NOT system bus
 *   artifact_upserted / artifact_applied
 */
import {
  getSseOutcomeError,
  sseConsumer,
  type SseHandle,
} from './sse-consumer.js';
import { sidecarClient } from '../api/sidecar-client.js';
import { tauriBridge } from './tauri-bridge.js';
import { showToast } from './toast.js';
import { useSettingsStore } from '../stores/settings-store.js';
import { useCardStore } from '../stores/card-store.js';
import { useMemoryStore } from '../stores/memory-store.js';
import { useKbStore } from '../stores/kb-store.js';
import type { EmaStreamEvent } from '@ema-agent/contracts';
import type { MemoryTaskKind } from '@ema-agent/storage';

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

  const handle = sseConsumer.start({
    openResponse: (signal) => sidecarClient.requestRaw('/api/system/events', {
      signal,
      headers: { Accept: 'text/event-stream' },
    }),
    onEvent: (event) => dispatchSystemEvent(event),
    onHeartbeat: () => {},
  });
  _handle = handle;

  void handle.done.then((outcome) => {
    if (_handle !== handle) return;
    _handle = null;
    if (outcome.kind === 'cancelled') return;

    const error = getSseOutcomeError(outcome);
    if (error) {
      console.error('[system-sse] connection ended, will retry', error.message);
      showToast(`系统连接中断，正在重试…(${error.message})`, {
        variant: 'warning',
        duration: 5000,
      });
    }
    scheduleReconnect(outcome.kind === 'eof' ? 3000 : 5000);
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

    // ── Memory pipeline telemetry (system bus) ────────────────────────────

    case 'memory_task_started':
      // event.kind is `string` in contracts (contracts has no storage dep);
      // backend only ever emits valid MemoryTaskKind values.
      useMemoryStore.getState().onTaskStarted(
        event.taskId,
        event.kind as MemoryTaskKind,
        event.sessionId as string | undefined,
      );
      break;

    case 'memory_task_completed':
      useMemoryStore.getState().onTaskCompleted(event.taskId);
      break;

    case 'memory_task_failed':
      useMemoryStore.getState().onTaskFailed(event.taskId, event.error);
      break;

    case 'memory_extraction_started':
      useMemoryStore.getState().onExtractionStarted(event.sessionId as string);
      break;

    case 'memory_extraction_completed':
      useMemoryStore.getState().onExtractionCompleted(event.sessionId as string, {
        nodes:      event.nodes,
        edges:      event.edges,
        items:      event.items,
        lazyQueued: event.lazyQueued,
        durationMs: event.durationMs,
      });
      break;

    case 'memory_extraction_failed':
      useMemoryStore.getState().onExtractionFailed(event.sessionId as string, event.error);
      break;

    case 'memory_index_rebuilt':
      useMemoryStore.getState().onIndexRebuilt();
      break;

    case 'memory_maintenance_completed':
      useMemoryStore.getState().onMaintenanceCompleted(event.decayedNodes, event.decayedItems, event.dryRun);
      break;

    case 'memory_maintenance_failed':
      useMemoryStore.getState().onMaintenanceFailed(event.error);
      break;

    // ── Knowledge-base ingest progress (background indexing) ──────────────
    case 'kb_ingest_progress':
      useKbStore.getState().onIngestProgress(event.kbId, event.taskId, event.assetId, event.stage, event.progress);
      break;

    case 'kb_ingest_completed':
      useKbStore.getState().onIngestCompleted(event.kbId, event.assetId);
      break;

    case 'kb_ingest_partial_failed':
      useKbStore.getState().onIngestPartialFailed(
        event.kbId,
        event.taskId,
        event.assetId,
        event.error,
        { total: event.totalItems, completed: event.completedItems, failed: event.failedItems },
      );
      break;

    case 'kb_ingest_failed':
      useKbStore.getState().onIngestFailed(event.kbId, event.assetId, event.error);
      break;

    // ── Knowledge-base re-embed progress (background index rebuild) ──────
    case 'kb_reembed_progress':
      useKbStore.getState().onReembedProgress(event.kbId, event.taskId, event.assetId, event.progress, {
        total: event.totalItems, completed: event.completedItems, failed: event.failedItems,
      });
      break;

    case 'kb_reembed_completed':
      useKbStore.getState().onReembedCompleted(event.kbId, event.taskId, event.assetId, {
        total: event.totalItems, completed: event.completedItems, failed: event.failedItems,
      });
      break;

    case 'kb_reembed_partial_failed':
      useKbStore.getState().onReembedPartialFailed(event.kbId, event.taskId, event.assetId, event.error, {
        total: event.totalItems, completed: event.completedItems, failed: event.failedItems,
      });
      break;

    case 'kb_reembed_cancelled':
      useKbStore.getState().onReembedCancelled(event.kbId, event.taskId, event.assetId);
      break;

    case 'kb_reembed_failed':
      useKbStore.getState().onReembedFailed(event.kbId, event.taskId, event.assetId, event.error);
      break;

    // ── Memory pipeline telemetry (Reserved — not yet emitted, Round 4.5) ─
    case 'memory_consolidation_started':
    case 'memory_consolidation_completed':
    case 'memory_consolidation_failed':
    case 'memory_node_merged':
      break;

    default:
      break;
  }
}
