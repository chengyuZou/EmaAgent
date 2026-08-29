// 为事件展示设置提供稳定的中文名称和业务分组，未知事件仍可回退展示协议名。
export type EventDisplayGroupId =
  | 'tool'
  | 'context'
  | 'knowledge'
  | 'agent'
  | 'character'
  | 'system';

export interface EventDisplayGroup {
  id: EventDisplayGroupId;
  label: string;
}

export const EVENT_DISPLAY_GROUPS: EventDisplayGroup[] = [
  { id: 'tool', label: '工具与权限' },
  { id: 'context', label: '上下文' },
  { id: 'knowledge', label: '知识库' },
  { id: 'agent', label: 'Agent 与子 Agent' },
  { id: 'character', label: '角色与舞台' },
  { id: 'system', label: '系统' },
];

const EVENT_LABELS: Record<string, string> = {
  tool_call_complete: '工具准备执行',
  tool_result: '工具执行结果',
  permission_required: '等待权限确认',
  permission_resolved: '权限确认完成',
  compact_started: '上下文压缩开始',
  compact_completed: '上下文压缩完成',
  compact_failed: '上下文压缩失败',
  compact_cancelled: '上下文压缩取消',
  kb_ingest_completed: '知识库文档处理完成',
  kb_ingest_failed: '知识库文档处理失败',
  kb_reembed_completed: '知识库重嵌入完成',
  kb_reembed_cancelled: '知识库重嵌入取消',
  kb_reembed_failed: '知识库重嵌入失败',
  agent_iteration: 'Agent 迭代进度',
  agent_run_started: '子 Agent 开始',
  agent_run_completed: '子 Agent 完成',
  agent_run_failed: '子 Agent 失败',
  agent_run_aborted: '子 Agent 中止',
  character_switched: '角色切换',
  background_process_changed: '后台进程状态变化',
  system_warning: '系统告警',
  tts_warning: '语音合成警告',
};

export function eventDisplayLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? eventType;
}

export function eventDisplayGroup(eventType: string): EventDisplayGroupId {
  if (eventType.startsWith('tool_') || eventType.startsWith('permission_')) return 'tool';
  if (eventType.startsWith('compact_')) return 'context';
  if (eventType.startsWith('kb_')) return 'knowledge';
  if (eventType.startsWith('agent_')) return 'agent';
  if (eventType.startsWith('character_') || eventType.startsWith('tts_')) return 'character';
  return 'system';
}
