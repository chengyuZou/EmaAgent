// 把结构化 SSE 事件转换为受用户设置控制的本地通知。
import type { ClientEvent } from '@ema-agent/events';
import { useSettingsStore, type EventDisplayConfig } from '../stores/settings-store.js';
import { showToast, type ToastOptions } from './toast.js';

export interface EventNotification {
  message: string;
  variant: NonNullable<ToastOptions['variant']>;
}

export interface ConfiguredEventNotification extends EventNotification {
  duration: number | null;
  accentColor: string;
}

export function describeEventNotification(event: ClientEvent): EventNotification | null {
  switch (event.type) {
    case 'tool_call_complete':
      return { message: `准备执行工具：${event.name}`, variant: 'info' };
    case 'tool_result':
      return event.error
        ? { message: `工具 ${event.name} 执行失败：${event.error.message}`, variant: 'danger' }
        : { message: `工具 ${event.name} 执行完成`, variant: 'success' };
    case 'permission_required':
      return { message: `工具 ${event.tool} 正在等待你的授权`, variant: 'warning' };
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
    case 'memory_recall_evidence':
      return {
        message: `${event.layer.toUpperCase()} 记忆召回 ${event.report.itemCount} 项`,
        variant: event.report.status === 'failed' ? 'warning' : 'info',
      };
    case 'context_compaction_started':
      return { message: '正在压缩上下文…', variant: 'info' };
    case 'context_compaction_completed':
      return { message: `上下文压缩完成，节省 ${event.savedTokens.toLocaleString()} tokens`, variant: 'success' };
    case 'context_compaction_failed':
      return { message: `上下文压缩失败：${event.error}`, variant: 'danger' };
    case 'memory_extraction_started':
      return { message: `开始提取记忆，队列中还有 ${event.queueDepth} 项`, variant: 'info' };
    case 'memory_extraction_completed':
      return { message: `记忆提取完成：${event.items} 项内容`, variant: 'success' };
    case 'memory_extraction_failed':
      return { message: `记忆提取失败：${event.error}`, variant: 'danger' };
    case 'memory_consolidation_started':
      return { message: `开始整理 ${event.nodeCount} 个记忆节点`, variant: 'info' };
    case 'memory_consolidation_completed':
      return { message: `记忆整理完成：${event.consolidated} 个节点`, variant: 'success' };
    case 'memory_consolidation_failed':
      return { message: `记忆整理失败：${event.error}`, variant: 'danger' };
    case 'memory_maintenance_completed':
      return { message: `记忆维护完成：处理 ${event.decayedNodes + event.decayedItems} 项`, variant: 'success' };
    case 'memory_maintenance_failed':
      return { message: `记忆维护失败：${event.error}`, variant: 'danger' };
    case 'memory_node_merged':
      return { message: `已合并记忆节点：${event.label}`, variant: 'info' };
    case 'memory_index_rebuilt':
      return { message: `记忆索引重建完成：${event.nodes + event.items} 项`, variant: 'success' };
    case 'memory_task_started':
      return { message: `后台记忆任务已开始：${event.kind}`, variant: 'info' };
    case 'memory_task_completed':
      return { message: `后台记忆任务已完成：${event.kind}`, variant: 'success' };
    case 'memory_task_failed':
      return { message: `后台记忆任务失败：${event.error}`, variant: 'danger' };
    case 'kb_ingest_completed':
      return { message: '知识库文档处理完成', variant: 'success' };
    case 'kb_ingest_partial_failed':
      return { message: `知识库文档部分处理失败：${event.error}`, variant: 'warning' };
    case 'kb_ingest_failed':
      return { message: `知识库文档处理失败：${event.error}`, variant: 'danger' };
    case 'kb_reembed_completed':
      return { message: `知识库重嵌入完成：${event.completedItems} 项`, variant: 'success' };
    case 'kb_reembed_partial_failed':
      return { message: `知识库重嵌入部分失败：${event.error}`, variant: 'warning' };
    case 'kb_reembed_cancelled':
      return { message: '知识库重嵌入已取消', variant: 'warning' };
    case 'kb_reembed_failed':
      return { message: `知识库重嵌入失败：${event.error}`, variant: 'danger' };
    case 'kb_embeddings_staled':
      return {
        message: event.markedStale > 0
          ? `知识库 Embedding 模型已更换为 ${event.model}，${event.markedStale} 个文档需要重新嵌入，请到知识库设置页重建索引`
          : `知识库 Embedding 模型已更换为 ${event.model}`,
        variant: event.failedKbIds.length > 0 ? 'danger' : 'warning',
      };
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
    case 'memory_recall_unavailable':
      return {
        message: `记忆召回失败，本轮对话将不带记忆上下文${event.retryable ? '（可重试）' : ''}`,
        variant: 'warning',
      };
    case 'memory_extraction_skipped':
      // reason 由后端给完整说明(如"未配置 memory 提取模型"),直接呈现不拼前缀。
      return { message: event.reason, variant: 'warning' };
    case 'memory_storage_budget_enforced':
      return {
        message: `记忆存储超出预算，已自动清理 ${event.deletedRows} 条记录与 ${event.evictedEmbeddings} 条向量`
          + (event.pressureRemaining ? '，仍高于低水位' : ''),
        variant: event.pressureRemaining ? 'warning' : 'info',
      };
    case 'memory_background_health_changed':
      // 只在退化边界发布:进入退化给警告,退出给恢复提示。
      if (event.health.state === 'degraded') {
        return {
          message: `Memory 后台维护已退化：${event.health.lastFailure?.message ?? '连续失败'}`,
          variant: 'warning',
        };
      }
      return { message: 'Memory 后台维护已恢复正常', variant: 'success' };
    case 'emotion_changed':
      return { message: `角色情绪切换为 ${event.state.primary}`, variant: 'info' };
    case 'stage_cue':
      return { message: `角色舞台动作：${event.cue.motion ?? event.cue.expression ?? '已更新'}`, variant: 'info' };
    case 'character_card_switched':
      return { message: `已切换角色：${event.name}`, variant: 'success' };
    case 'subagent_started':
      return { message: `子 Agent 已开始：${event.description ?? event.promptExcerpt}`, variant: 'info' };
    case 'subagent_progress':
      return { message: `子 Agent 正在执行第 ${event.iteration} 轮`, variant: 'info' };
    case 'subagent_completed':
      return { message: `子 Agent 已完成：${event.outputExcerpt}`, variant: 'success' };
    case 'subagent_failed':
      return { message: `子 Agent 执行失败：${event.error}`, variant: 'danger' };
    case 'subagent_aborted':
      return { message: `子 Agent 已中止：${event.reason}`, variant: 'warning' };
    case 'agent_iteration':
      return { message: `Agent 正在执行第 ${event.n} 轮`, variant: 'info' };
    case 'agent_breaker_tripped':
      return { message: `Agent 已停止：${event.reason}`, variant: 'danger' };
    case 'system_warning':
      return { message: event.message, variant: event.level === 'error' ? 'danger' : event.level === 'warn' ? 'warning' : 'info' };
    default:
      return null;
  }
}

export function resolveConfiguredEventNotification(
  event: ClientEvent,
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

export function presentConfiguredEvent(event: ClientEvent): void {
  const config = useSettingsStore.getState().eventDisplay?.effective[event.type];
  const notification = resolveConfiguredEventNotification(event, config);
  if (!notification) return;
  showToast(notification.message, {
    variant: notification.variant,
    duration: notification.duration,
    accentColor: notification.accentColor,
  });
}
