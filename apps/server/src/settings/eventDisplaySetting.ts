import { z } from 'zod';
import { defineSetting } from '@ema-agent/settings/definition';

const eventDisplayConfigSchema = z.object({
  enabled: z.boolean(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** null = 常驻不自动消失. */
  durationMs: z.number().int().min(0).max(600_000).nullable(),
  truncateChars: z.number().int().min(1).max(10_000).optional(),
});

export type EventDisplayConfig = z.infer<typeof eventDisplayConfigSchema>;

/** 用户覆盖表:key 是传输层事件类型名;未列出的类型走默认表. */
export const eventDisplaySetting = defineSetting({
  key: 'frontend.eventDisplay',
  apply: 'immediate',
  defaultValue: {},
  schema: z.record(z.string(), eventDisplayConfigSchema),
});

/**
 * 默认展示表包含 Session 连接和应用 SSE 的提示类型, 前端设置页据此列出可配置项.
 */
export const DEFAULT_EVENT_DISPLAY: Record<string, EventDisplayConfig> = {
  tool_call_complete:           { enabled: true,  color: '#3b82f6', durationMs: 4000 },
  tool_result:                  { enabled: true,  color: '#22c55e', durationMs: 3000 },
  permission_required:          { enabled: true,  color: '#ef4444', durationMs: null },
  permission_resolved:          { enabled: true,  color: '#22c55e', durationMs: 2000 },
  compact_started:              { enabled: false, color: '#f59e0b', durationMs: 2000 },
  compact_completed:            { enabled: true,  color: '#f59e0b', durationMs: 5000 },
  compact_failed:               { enabled: true,  color: '#ef4444', durationMs: 5000 },
  compact_cancelled:            { enabled: true,  color: '#94a3b8', durationMs: 3000 },
  character_switched:             { enabled: true,  color: '#f59e0b', durationMs: 4000 },
  background_process_changed:   { enabled: true,  color: '#64748b', durationMs: 3000 },
  system_warning:               { enabled: true,  color: '#f59e0b', durationMs: 5000 },
  subagent_started:            { enabled: true,  color: '#8b5cf6', durationMs: null },
  subagent_completed:          { enabled: true,  color: '#22c55e', durationMs: 4000 },
  subagent_failed:             { enabled: true,  color: '#ef4444', durationMs: 5000 },
  subagent_aborted:            { enabled: true,  color: '#94a3b8', durationMs: 3000 },
  agent_iteration:              { enabled: false, color: '#64748b', durationMs: 1000 },
};

/** 合并默认表与用户覆盖,产出前端消费的生效表. */
export function resolveEventDisplay(
  overrides: Record<string, EventDisplayConfig>,
): Record<string, EventDisplayConfig> {
  return { ...DEFAULT_EVENT_DISPLAY, ...overrides };
}
