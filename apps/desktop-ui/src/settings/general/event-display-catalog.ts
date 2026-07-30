// 为事件展示设置提供稳定的中文名称和业务分组，未知事件仍可回退展示协议名。
export type EventDisplayGroupId =
  | 'tool'
  | 'narrative'
  | 'memory'
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
  { id: 'narrative', label: '剧情检索' },
  { id: 'memory', label: '记忆系统' },
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
  narrative_route_resolved: '剧情检索路线确定',
  narrative_timeline_complete: '剧情时间线检索完成',
  narrative_recall_unavailable: '剧情召回不可用',
  memory_recall_evidence: '记忆召回结果',
  context_compaction_started: '上下文压缩开始',
  context_compaction_completed: '上下文压缩完成',
  context_compaction_failed: '上下文压缩失败',
  context_compaction_skipped: '上下文压缩跳过',
  memory_extraction_started: '记忆提取开始',
  memory_extraction_completed: '记忆提取完成',
  memory_extraction_failed: '记忆提取失败',
  memory_consolidation_started: '记忆整理开始',
  memory_consolidation_completed: '记忆整理完成',
  memory_consolidation_failed: '记忆整理失败',
  memory_maintenance_completed: '记忆维护完成',
  memory_maintenance_failed: '记忆维护失败',
  memory_node_merged: '记忆节点合并',
  memory_index_rebuilt: '记忆索引重建',
  memory_task_started: '后台记忆任务开始',
  memory_task_completed: '后台记忆任务完成',
  memory_task_failed: '后台记忆任务失败',
  memory_recall_unavailable: '记忆召回不可用',
  memory_extraction_skipped: '记忆提取跳过',
  memory_storage_budget_enforced: '记忆存储预算执行',
  memory_background_health_changed: '记忆后台健康变化',
  kb_ingest_completed: '知识库文档处理完成',
  kb_ingest_partial_failed: '知识库文档部分失败',
  kb_ingest_failed: '知识库文档处理失败',
  kb_reembed_completed: '知识库重嵌入完成',
  kb_reembed_partial_failed: '知识库重嵌入部分失败',
  kb_reembed_cancelled: '知识库重嵌入取消',
  kb_reembed_failed: '知识库重嵌入失败',
  kb_embeddings_staled: '知识库嵌入模型已更换',
  agent_iteration: 'Agent 迭代进度',
  agent_breaker_tripped: 'Agent 安全停止',
  subagent_started: '子 Agent 开始',
  subagent_progress: '子 Agent 进度',
  subagent_completed: '子 Agent 完成',
  subagent_failed: '子 Agent 失败',
  subagent_aborted: '子 Agent 中止',
  subagent_stream: '子 Agent 详情流',
  emotion_changed: '角色情绪变化',
  stage_cue: '角色舞台动作',
  character_card_switched: '角色切换',
  provider_health_changed: '服务健康状态变化',
  background_process_changed: '后台进程状态变化',
  hook_warning: 'Hook 告警',
  system_warning: '系统告警',
  tts_chunk: '语音数据块',
  tts_sentence_complete: '语音句子完成',
  tts_warning: '语音合成警告',
};

export function eventDisplayLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? eventType;
}

export function eventDisplayGroup(eventType: string): EventDisplayGroupId {
  if (eventType.startsWith('tool_') || eventType.startsWith('permission_')) return 'tool';
  if (eventType.startsWith('narrative_')) return 'narrative';
  if (eventType.startsWith('memory_')) return 'memory';
  if (eventType.startsWith('kb_')) return 'knowledge';
  if (eventType.startsWith('agent_') || eventType.startsWith('subagent_')) return 'agent';
  if (eventType.startsWith('emotion_') || eventType.startsWith('stage_') || eventType.startsWith('character_') || eventType.startsWith('tts_')) return 'character';
  return 'system';
}
