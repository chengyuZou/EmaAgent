// 把结构化 SSE 事件转换为受用户设置控制的本地通知。

import type { AppEvent, TurnSseEvent } from '@ema-agent/server/sse/eventHub.js';
import { useSettingsStore, type EventDisplayConfig } from '../stores/settings.js';
import { showToast, type ToastOptions } from './toast.js';

/** 通知层可见的全部线上事件：Turn 流（含语音输出）+ 应用级广播。 */
export type NotifiableEvent = TurnSseEvent | AppEvent;

export interface EventNotification {
  message: string;
  variant: NonNullable<ToastOptions['variant']>;
}

export interface ConfiguredEventNotification extends EventNotification {
  duration: number | null;
  accentColor: string;
}

export function describeEventNotification(event: NotifiableEvent): EventNotification | null {
  switch (event.type) {
    case 'tool_call_complete':
      return { message: `准备执行工具：${event.name}`, variant: 'info' };
    case 'tool_result':
      return event.error
        ? { message: `工具 ${event.name} 执行失败：${event.error.message}`, variant: 'danger' }
        : { message: `工具 ${event.name} 执行完成`, variant: 'success' };
    case 'permission_required':
      return { message: `工具 ${event.toolName} 正在等待你的授权`, variant: 'warning' };
    case 'permission_resolved':
      return {
        message: event.decision === 'allow' ? '工具权限已允许' : '工具权限已拒绝',
        variant: event.decision === 'allow' ? 'success' : 'warning',
      };
    case 'narrative_recall_started':
      return { message: '正在检索剧情资料', variant: 'info' };
    case 'narrative_recall_completed':
      return event.timelineOrder.length === 0
        ? { message: '未找到相关剧情资料', variant: 'info' }
        : {
            message: `剧情检索完成：${event.timelines.length}/${event.timelineOrder.length} 条时间线可用`,
            variant: event.failures.length > 0 ? 'warning' : 'success',
          };
    case 'narrative_recall_failed':
      return { message: `剧情检索失败：${event.message}`, variant: 'warning' };
    case 'compact_started':
      return { message: '正在压缩上下文…', variant: 'info' };
    case 'compact_completed':
      return { message: `上下文压缩完成，节省 ${event.savedTokens.toLocaleString()} tokens`, variant: 'success' };
    case 'compact_failed':
      return { message: `上下文压缩失败：${event.error}`, variant: 'danger' };
    case 'kb_ingest_completed':
      return { message: '知识库文档处理完成', variant: 'success' };
    case 'kb_ingest_failed':
      return { message: `知识库文档处理失败：${event.error}`, variant: 'danger' };
    case 'kb_reembed_completed':
      return { message: '知识库重嵌入完成', variant: 'success' };
    case 'kb_reembed_cancelled':
      return { message: '知识库重嵌入已取消', variant: 'warning' };
    case 'kb_reembed_failed':
      return { message: `知识库重嵌入失败：${event.error}`, variant: 'danger' };
    case 'background_process_changed':
      // 只给失败/超时弹通知;完成、停止与运行状态变化只更新面板(2026-07-30 拍板)。
      if (event.status === 'failed') {
        return {
          message: `后台进程执行失败${event.terminationReason ? `：${event.terminationReason}` : ''}`,
          variant: 'danger',
        };
      }
      if (event.status === 'timedOut') {
        return { message: '后台进程超出最大运行时间，已被终止', variant: 'warning' };
      }
      return null;
    case 'tts_warning':
      return {
        message: `语音合成${event.severity === 'error' ? '失败' : '警告'}：${event.message}`,
        variant: event.severity === 'error' ? 'danger' : 'warning',
      };
    case 'emotion_changed':
      return { message: `角色情绪切换为 ${event.emotion}`, variant: 'info' };
    case 'motion_changed':
      return { message: `角色舞台动作：${event.motion}`, variant: 'info' };
    case 'character_switched':
      return { message: `已切换角色：${event.name}`, variant: 'success' };
    case 'agent_run_started':
      return { message: `子 Agent 已开始${event.description ? `：${event.description}` : ''}`, variant: 'info' };
    case 'agent_run_completed':
      return { message: `子 Agent 已完成：${event.finalText}`, variant: 'success' };
    case 'agent_run_failed':
      return { message: `子 Agent 执行失败：${event.error}`, variant: 'danger' };
    case 'agent_run_aborted':
      return { message: `子 Agent 已中止：${event.reason}`, variant: 'warning' };
    case 'agent_iteration':
      return { message: `Agent 正在执行第 ${event.n} 轮`, variant: 'info' };
    case 'system_warning':
      return { message: event.message, variant: event.level === 'error' ? 'danger' : event.level === 'warn' ? 'warning' : 'info' };
    default:
      return null;
  }
}

export function resolveConfiguredEventNotification(
  event: NotifiableEvent,
  config: EventDisplayConfig | undefined,
): ConfiguredEventNotification | null {
  if (!config?.enabled) return null;
  const presentation = describeEventNotification(event);
  if (!presentation) return null;

  const limit = config.truncateChars;
  const message = limit && presentation.message.length > limit
    ? `${presentation.message.slice(0, limit)}…`
    : presentation.message;
  return {
    ...presentation,
    message,
    duration: config.durationMs,
    accentColor: config.color,
  };
}

export function presentConfiguredEvent(event: NotifiableEvent): void {
  const config = useSettingsStore.getState().eventDisplay?.[event.type];
  const notification = resolveConfiguredEventNotification(event, config);
  if (!notification) return;
  showToast(notification.message, {
    variant: notification.variant,
    duration: notification.duration,
    accentColor: notification.accentColor,
  });
}
