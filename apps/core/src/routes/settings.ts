import { Hono } from 'hono';
import { z } from 'zod';
import { SettingsRepo } from '@ema-agent/storage';
import type { AppBindings } from '../wiring.js';

// ── Settings keys (typed) ────────────────────────────────────────────────────

const SETTINGS_KEY_EVENT_DISPLAY      = 'frontend.eventDisplay';
const SETTINGS_KEY_PERMISSION_TIMEOUT = 'permission.askTimeoutMs';
const SETTINGS_KEY_THEME              = 'frontend.theme';

// ── Event-display defaults ───────────────────────────────────────────────────
//
// Per-event-type bubble settings the frontend uses to decide:
//   - whether to render (`enabled`)
//   - what color the bubble is
//   - how long it stays visible (null = sticky)
//   - optional `truncateChars` for very long content events
//
// Frontend merges these defaults with the persisted user override on load.
// Anything not in this map is treated as "do not render".

interface EventDisplayConfig {
  enabled:        boolean;
  color:          string;
  durationMs:     number | null;
  truncateChars?: number;
}

const DEFAULT_EVENT_DISPLAY: Record<string, EventDisplayConfig> = {
  // Tool execution
  tool_call_complete:           { enabled: true,  color: '#3b82f6', durationMs: 4000 },
  tool_result:                  { enabled: true,  color: '#22c55e', durationMs: 3000 },

  // Permission — sticky until resolved
  permission_required:          { enabled: true,  color: '#ef4444', durationMs: null },
  permission_resolved:          { enabled: true,  color: '#22c55e', durationMs: 2000 },

  // Narrative recall
  narrative_route_resolved:     { enabled: true,  color: '#8b5cf6', durationMs: 3000 },
  narrative_timeline_complete:  { enabled: true,  color: '#8b5cf6', durationMs: 5000, truncateChars: 100 },
  recall_evidence:              { enabled: true,  color: '#ec4899', durationMs: 3000 },

  // Memory
  context_compacted:            { enabled: true,  color: '#f59e0b', durationMs: 5000 },
  memory_extraction_started:    { enabled: false, color: '#a855f7', durationMs: 2000 },
  memory_extraction_completed:  { enabled: true,  color: '#a855f7', durationMs: 4000 },
  memory_extraction_failed:     { enabled: true,  color: '#ef4444', durationMs: 5000 },
  memory_consolidation_started: { enabled: false, color: '#a855f7', durationMs: 2000 },
  memory_consolidation_completed: { enabled: true, color: '#a855f7', durationMs: 3000 },
  memory_maintenance_completed: { enabled: true,  color: '#0ea5e9', durationMs: 4000 },
  memory_node_merged:           { enabled: false, color: '#a855f7', durationMs: 2000 },
  memory_index_rebuilt:         { enabled: true,  color: '#0ea5e9', durationMs: 3000 },

  // Background tasks
  background_task_started:      { enabled: false, color: '#64748b', durationMs: 1500 },
  background_task_completed:    { enabled: false, color: '#64748b', durationMs: 1500 },
  background_task_failed:       { enabled: true,  color: '#ef4444', durationMs: 5000 },

  // Stage / emotion
  emotion_changed:              { enabled: false, color: '#f472b6', durationMs: 1500 },
  stage_cue:                    { enabled: false, color: '#f472b6', durationMs: 1500 },

  // TTS — audio, never bubble
  tts_chunk:                    { enabled: false, color: '#000000', durationMs: 0 },
  tts_sentence_complete:        { enabled: false, color: '#000000', durationMs: 0 },

  // System
  character_card_switched:      { enabled: true,  color: '#f59e0b', durationMs: 4000 },
  provider_health_changed:      { enabled: true,  color: '#0ea5e9', durationMs: 3000 },
  system_warning:               { enabled: true,  color: '#f59e0b', durationMs: 5000 },

  // Sub-agent dashboard
  subagent_started:             { enabled: true,  color: '#8b5cf6', durationMs: null },
  subagent_progress:            { enabled: false, color: '#8b5cf6', durationMs: 1500 },
  subagent_completed:           { enabled: true,  color: '#22c55e', durationMs: 4000 },
  subagent_failed:              { enabled: true,  color: '#ef4444', durationMs: 5000 },
  subagent_aborted:             { enabled: true,  color: '#94a3b8', durationMs: 3000 },
  // High-frequency detail stream — disabled in toast/notification by default;
  // frontend subscribes to subagent_stream directly for the detail panel.
  subagent_stream:              { enabled: false, color: '#8b5cf6', durationMs: null },

  // Agent
  agent_iteration:              { enabled: false, color: '#64748b', durationMs: 1000 },
  agent_breaker_tripped:        { enabled: true,  color: '#ef4444', durationMs: 5000 },
};

const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;

// ── Schemas ──────────────────────────────────────────────────────────────────

const eventDisplayEntrySchema = z.object({
  enabled:       z.boolean(),
  color:         z.string(),
  durationMs:    z.number().nullable(),
  truncateChars: z.number().int().min(1).max(10_000).optional(),
});

const eventDisplayBodySchema = z.record(z.string(), eventDisplayEntrySchema);

const permissionTimeoutBodySchema = z.object({
  timeoutMs: z.number().int().min(5_000).max(600_000),
});

const themeBodySchema = z.object({
  hue:    z.number().min(0).max(360),
  radius: z.number().min(0).max(3),
});

type ThemeConfig = z.infer<typeof themeBodySchema>;

const DEFAULT_THEME: ThemeConfig = { hue: 350, radius: 1 };

// ── Route factory ────────────────────────────────────────────────────────────

/**
 * Generic settings endpoints. Currently exposes:
 *   GET /api/settings/event-display      — defaults merged with user overrides
 *   PUT /api/settings/event-display      — replace user overrides
 *   GET /api/settings/permission-timeout — { timeoutMs }
 *   PUT /api/settings/permission-timeout — { timeoutMs }
 *
 * Settings live in the `settings` table as JSON blobs. Per-key handlers add
 * type-safe schemas; the table itself is generic key-value.
 */
export function settingsRoute(bindings: AppBindings): Hono {
  const app = new Hono();
  const repo = new SettingsRepo(bindings.profileDb.sqlite);

  // ── Event-display ─────────────────────────────────────────────────────────
  app.get('/event-display', (c) => {
    const stored = repo.get(SETTINGS_KEY_EVENT_DISPLAY) as
      | Record<string, EventDisplayConfig>
      | undefined;
    return c.json({
      defaults: DEFAULT_EVENT_DISPLAY,
      overrides: stored ?? {},
      effective: { ...DEFAULT_EVENT_DISPLAY, ...(stored ?? {}) },
    });
  });

  app.put('/event-display', async (c) => {
    const parsed = eventDisplayBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    repo.set(SETTINGS_KEY_EVENT_DISPLAY, parsed.data);
    return c.json({ ok: true });
  });

  // ── Permission timeout ────────────────────────────────────────────────────
  app.get('/permission-timeout', (c) => {
    const stored = repo.get(SETTINGS_KEY_PERMISSION_TIMEOUT) as number | undefined;
    return c.json({ timeoutMs: stored ?? DEFAULT_PERMISSION_TIMEOUT_MS });
  });

  app.put('/permission-timeout', async (c) => {
    const parsed = permissionTimeoutBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    repo.set(SETTINGS_KEY_PERMISSION_TIMEOUT, parsed.data.timeoutMs);
    bindings.permissionPrompts.setDefaultTimeout(parsed.data.timeoutMs);
    return c.json({ ok: true });
  });

  // ── Theme (hue + radius) ──────────────────────────────────────────────────
  app.get('/theme', (c) => {
    const stored = repo.get(SETTINGS_KEY_THEME) as ThemeConfig | undefined;
    return c.json({ ...DEFAULT_THEME, ...stored });
  });

  app.put('/theme', async (c) => {
    const parsed = themeBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    repo.set(SETTINGS_KEY_THEME, parsed.data);
    return c.json({ ok: true });
  });

  return app;
}
