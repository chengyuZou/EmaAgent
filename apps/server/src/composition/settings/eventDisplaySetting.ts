// 前端事件提示条的外观设置：默认表 + 用户覆盖合并（frontend.* 例外，托管于 server，见 src/settings/README）。
import { z } from 'zod';
import { defineSetting } from '@ema-agent/settings';

const eventDisplayConfigSchema = z.object({
  enabled: z.boolean(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** null = 常驻不自动消失。 */
  durationMs: z.number().int().min(0).max(600_000).nullable(),
  truncateChars: z.number().int().min(1).max(10_000).optional(),
});

export type EventDisplayConfig = z.infer<typeof eventDisplayConfigSchema>;

/** 用户覆盖表：key 是传输层事件类型名；未列出的类型走默认表。 */
export const eventDisplaySetting = defineSetting({
  key: 'frontend.eventDisplay',
  apply: 'immediate',
  defaultValue: {},
  schema: z.record(z.string(), eventDisplayConfigSchema),
});

/**
 * 默认展示表：只列当前真实存在的事件类型（Turn/Tool/Permission/Compact/AgentRun/KB/Speech/App）。
 * Memory 域事件名归 Sol 的 Memory 包接线时补；旧 central events 联合与 legacy key 迁移已随包删除。
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
  kb_ingest_completed:          { enabled: true,  color: '#22c55e', durationMs: 3000 },
  kb_ingest_failed:             { enabled: true,  color: '#ef4444', durationMs: 5000 },
  kb_reembed_completed:         { enabled: true,  color: '#22c55e', durationMs: 3000 },
  kb_reembed_cancelled:         { enabled: true,  color: '#94a3b8', durationMs: 3000 },
  kb_reembed_failed:            { enabled: true,  color: '#ef4444', durationMs: 5000 },
  tts_warning:                  { enabled: true,  color: '#f59e0b', durationMs: 4000, truncateChars: 120 },
  character_switched:             { enabled: true,  color: '#f59e0b', durationMs: 4000 },
  background_process_changed:   { enabled: true,  color: '#64748b', durationMs: 3000 },
  system_warning:               { enabled: true,  color: '#f59e0b', durationMs: 5000 },
  agent_run_started:            { enabled: true,  color: '#8b5cf6', durationMs: null },
  agent_run_completed:          { enabled: true,  color: '#22c55e', durationMs: 4000 },
  agent_run_failed:             { enabled: true,  color: '#ef4444', durationMs: 5000 },
  agent_run_aborted:            { enabled: true,  color: '#94a3b8', durationMs: 3000 },
  agent_iteration:              { enabled: false, color: '#64748b', durationMs: 1000 },
};

/** 合并默认表与用户覆盖，产出前端消费的生效表。 */
export function resolveEventDisplay(
  overrides: Record<string, EventDisplayConfig>,
): Record<string, EventDisplayConfig> {
  return { ...DEFAULT_EVENT_DISPLAY, ...overrides };
}
