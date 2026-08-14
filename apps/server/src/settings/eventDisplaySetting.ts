// 定义前端事件提示条的默认外观、旧字段迁移和设置校验。

import type { ClientEvent } from '@ema-agent/events';
import { defineSetting } from '@ema-agent/settings';

export interface EventDisplayConfig {
  enabled: boolean;
  color: string;
  durationMs: number | null;
  truncateChars?: number;
}

export const DEFAULT_EVENT_DISPLAY: Partial<Record<ClientEvent['type'], EventDisplayConfig>> = {
  tool_call_complete:           { enabled: true,  color: '#3b82f6', durationMs: 4000 },
  tool_result:                  { enabled: true,  color: '#22c55e', durationMs: 3000 },
  permission_required:          { enabled: true,  color: '#ef4444', durationMs: null },
  permission_resolved:          { enabled: true,  color: '#22c55e', durationMs: 2000 },
  narrative_recall_started:     { enabled: false, color: '#8b5cf6', durationMs: 2000 },
  narrative_recall_completed:   { enabled: true,  color: '#8b5cf6', durationMs: 5000, truncateChars: 120 },
  narrative_recall_failed:      { enabled: true,  color: '#f59e0b', durationMs: 5000, truncateChars: 160 },
  memory_recall_evidence:       { enabled: true,  color: '#ec4899', durationMs: 3000 },
  context_compaction_started:   { enabled: false, color: '#f59e0b', durationMs: 2000 },
  context_compaction_completed: { enabled: true,  color: '#f59e0b', durationMs: 5000 },
  context_compaction_failed:    { enabled: true,  color: '#ef4444', durationMs: 5000 },
  memory_extraction_started:    { enabled: false, color: '#a855f7', durationMs: 2000 },
  memory_extraction_completed:  { enabled: true,  color: '#a855f7', durationMs: 4000 },
  memory_extraction_failed:     { enabled: true,  color: '#ef4444', durationMs: 5000 },
  memory_consolidation_started: { enabled: false, color: '#a855f7', durationMs: 2000 },
  memory_consolidation_completed: { enabled: true, color: '#a855f7', durationMs: 3000 },
  memory_consolidation_failed:  { enabled: true,  color: '#ef4444', durationMs: 5000 },
  memory_maintenance_completed: { enabled: true,  color: '#0ea5e9', durationMs: 4000 },
  memory_maintenance_failed:    { enabled: true,  color: '#ef4444', durationMs: 5000 },
  memory_node_merged:           { enabled: false, color: '#a855f7', durationMs: 2000 },
  memory_index_rebuilt:         { enabled: true,  color: '#0ea5e9', durationMs: 3000 },
  memory_task_started:          { enabled: false, color: '#64748b', durationMs: 1500 },
  memory_task_completed:        { enabled: false, color: '#64748b', durationMs: 1500 },
  memory_task_failed:           { enabled: true,  color: '#ef4444', durationMs: 5000 },
  memory_recall_unavailable:    { enabled: true,  color: '#f59e0b', durationMs: 5000, truncateChars: 120 },
  memory_extraction_skipped:    { enabled: true,  color: '#f59e0b', durationMs: 5000, truncateChars: 120 },
  memory_storage_budget_enforced: { enabled: true, color: '#0ea5e9', durationMs: 4000 },
  memory_background_health_changed: { enabled: true, color: '#f59e0b', durationMs: 5000 },
  kb_ingest_completed:          { enabled: true,  color: '#22c55e', durationMs: 3000 },
  kb_ingest_partial_failed:     { enabled: true,  color: '#f59e0b', durationMs: 5000 },
  kb_ingest_failed:             { enabled: true,  color: '#ef4444', durationMs: 5000 },
  kb_reembed_completed:         { enabled: true,  color: '#22c55e', durationMs: 3000 },
  kb_reembed_partial_failed:    { enabled: true,  color: '#f59e0b', durationMs: 5000 },
  kb_reembed_cancelled:         { enabled: true,  color: '#94a3b8', durationMs: 3000 },
  kb_reembed_failed:            { enabled: true,  color: '#ef4444', durationMs: 5000 },
  kb_embeddings_staled:         { enabled: true,  color: '#f59e0b', durationMs: 6000 },
  emotion_changed:              { enabled: false, color: '#f472b6', durationMs: 1500 },
  stage_cue:                    { enabled: false, color: '#f472b6', durationMs: 1500 },
  tts_chunk:                    { enabled: false, color: '#f472b6', durationMs: 1500 },
  tts_sentence_complete:        { enabled: false, color: '#f472b6', durationMs: 1500 },
  tts_warning:                  { enabled: true,  color: '#f59e0b', durationMs: 4000, truncateChars: 120 },
  character_card_switched:      { enabled: true,  color: '#f59e0b', durationMs: 4000 },
  character_presentation_changed: { enabled: false, color: '#f59e0b', durationMs: 1500 },
  background_process_changed:   { enabled: true,  color: '#64748b', durationMs: 3000 },
  system_warning:               { enabled: true,  color: '#f59e0b', durationMs: 5000 },
  subagent_started:             { enabled: true,  color: '#8b5cf6', durationMs: null },
  subagent_progress:            { enabled: false, color: '#8b5cf6', durationMs: 1500 },
  subagent_completed:           { enabled: true,  color: '#22c55e', durationMs: 4000 },
  subagent_failed:              { enabled: true,  color: '#ef4444', durationMs: 5000 },
  subagent_aborted:             { enabled: true,  color: '#94a3b8', durationMs: 3000 },
  agent_iteration:              { enabled: false, color: '#64748b', durationMs: 1000 },
  agent_breaker_tripped:        { enabled: true,  color: '#ef4444', durationMs: 5000 },
};

const LEGACY_EVENT_DISPLAY_KEYS: Record<string, ClientEvent['type']> = {
  context_compacted: 'context_compaction_completed',
  memory_compaction_started: 'context_compaction_started',
  memory_compaction_completed: 'context_compaction_completed',
  memory_compaction_failed: 'context_compaction_failed',
  recall_evidence: 'memory_recall_evidence',
  background_task_started: 'memory_task_started',
  background_task_completed: 'memory_task_completed',
  background_task_failed: 'memory_task_failed',
};

export const eventDisplaySetting = defineSetting<Record<string, EventDisplayConfig>>({
  key: 'frontend.eventDisplay',
  kind: 'object',
  apply: 'immediate',
  defaultValue: {},
  decode(value: unknown) {
    if (!isRecord(value)) return { ok: false };
    return { ok: true, value: normalizeEventDisplayOverrides(value) };
  },
});

export function normalizeEventDisplayOverrides(value: unknown): Record<string, EventDisplayConfig> {
  if (!isRecord(value)) return {};
  const normalized: Record<string, EventDisplayConfig> = {};
  for (const [rawKey, rawConfig] of Object.entries(value)) {
    const config = decodeEventDisplayConfig(rawConfig);
    if (!config) continue;
    const key = LEGACY_EVENT_DISPLAY_KEYS[rawKey] ?? rawKey;
    if (!(key in normalized) || !(rawKey in LEGACY_EVENT_DISPLAY_KEYS)) {
      normalized[key] = config;
    }
  }
  return normalized;
}

function decodeEventDisplayConfig(value: unknown): EventDisplayConfig | null {
  if (!isRecord(value)) return null;
  if (typeof value['enabled'] !== 'boolean') return null;
  if (typeof value['color'] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value['color'])) return null;
  const durationMs = value['durationMs'];
  if (durationMs !== null && (
    !Number.isInteger(durationMs)
    || (durationMs as number) < 0
    || (durationMs as number) > 600_000
  )) return null;
  const truncateChars = value['truncateChars'];
  if (truncateChars !== undefined && (
    !Number.isInteger(truncateChars)
    || (truncateChars as number) < 1
    || (truncateChars as number) > 10_000
  )) return null;
  return {
    enabled: value['enabled'],
    color: value['color'],
    durationMs: durationMs as number | null,
    ...(truncateChars === undefined ? {} : { truncateChars: truncateChars as number }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
