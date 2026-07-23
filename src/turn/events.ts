// 组合各业务域事件，形成 Turn 向客户端输出的统一结构化事件流。
import type {
  AgentRunId,
  CharacterCardId,
  CompactionId,
  HookInvocationId,
  SessionId,
  TaskId,
  TurnId,
} from '@ema-agent/ids';
import type { Artifact, ArtifactId } from '@ema-agent/artifact';
import type { TurnFailureCode } from './errors.js';
import type { ProviderStreamEvent } from '@ema-agent/provider';
import type { PermissionStreamEvent } from '@ema-agent/permission';
import type { EmotionStreamEvent } from '@ema-agent/emotion';
import type { ExecutionProfile, NarrativePolicy, TurnStats } from './turns.js';

/** 子 Agent 获取初始上下文的方式。 */
export type AgentKind = 'subagent' | 'fork';

/** 文件工具提交成功后给客户端使用的有界真实变更。 */
export interface FileChangePresentation {
  kind: 'file_change';
  operation: 'create' | 'update';
  filePath: string;
  unifiedDiff: string;
  additions: number;
  deletions: number;
  truncated: boolean;
  omittedReason?: string;
}

export type ToolPresentation = FileChangePresentation;

// ── 共用子类型 ────────────────────────────────────────────────────────────────

export type { TurnStats };

export interface ToolError {
  code: string;
  message: string;
}

/** Hook 运行时告警的稳定分类；协议层不依赖 Hook 包，避免反向耦合。 */
export type HookWarningFailureKind =
  | 'handler_error'
  | 'timeout'
  | 'protocol_violation';

export type NarrativeTimelineFailureCode =
  | 'narrative/unavailable'
  | 'narrative/timeout'
  | 'narrative/http_error'
  | 'narrative/invalid_response'
  | 'narrative/unknown';

/**
 * `subagent_stream` 内的高频明细事件。
 *
 * `subagentId` 暂时保留为客户端协议字段名，但值的真实类型是 AgentRunId；
 * 它绝不是 TurnId。taskId 仅在本次执行关联了用户可见工作项时出现。
 */
export type SubagentInnerEvent =
  /** 新一轮 LLM 迭代及累计耗时。 */
  | { type: 'iteration';
      sessionId: SessionId; subagentId: AgentRunId; taskId?: TaskId;
      n: number; elapsedMs: number }
  /** 流式助手文本。 */
  | { type: 'text_delta';
      sessionId: SessionId; subagentId: AgentRunId; taskId?: TaskId;
      delta: string }
  /** 流式推理文本，仅用于展示和审计。 */
  | { type: 'reasoning_delta';
      sessionId: SessionId; subagentId: AgentRunId; taskId?: TaskId;
      delta: string }
  /** 已派发工具调用；渲染前仍需限制参数体积。 */
  | { type: 'tool_call';
      sessionId: SessionId; subagentId: AgentRunId; taskId?: TaskId;
      callId: string; name: string; args: unknown; iteration: number }
  /** 工具调用完成；excerpt 是有界预览，bytes 是原结果体积。 */
  | { type: 'tool_result';
      sessionId: SessionId; subagentId: AgentRunId; taskId?: TaskId;
      callId: string; name: string; excerpt: string; bytes: number;
      isError: boolean; error?: ToolError; durationMs: number }

export interface LipSyncFrame {
  t: number;
  mouth: number;
}

/**
 * ask_user_required 批次中的一个问题。结构与内置 ask_user 工具输入一致，
 * 额外提供稳定 id，供 Orchestrator 把回答关联回原问题。
 */
export interface AskUserQuestionSpec {
  /** 批次内稳定的问题 ID，例如 q0、q1，同时作为 answers 的键。 */
  id: string;
  /** 展示给用户的问题正文。 */
  question: string;
  /** UI 中显示为标签的短标题，最多 12 个字符。 */
  header: string;
  /**
   * 选择题选项；自由文本问题省略。
   * 提供选项时，multiSelect 决定 UI 是否允许多选。
   */
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  /** 为 true 时，UI 在选项旁提供“其他（自定义）”文本输入。 */
  allowCustom?: boolean;
  /** 文本问题输入框中的占位提示。 */
  placeholder?: string;
}

export type MemoryRecallLayer = 'layer0' | 'layer1' | 'layer2';
export type MemoryRecallLayerStatus = 'succeeded' | 'skipped' | 'failed';

export interface MemoryRecallLayerReport {
  status: MemoryRecallLayerStatus;
  itemCount: number;
  tokenEstimate: number;
  durationMs: number;
  error?: string;
  skippedReason?: string;
}

/** 请求在调用 Provider 前执行的可观测兼容降级。 */
export interface RequestDegradationNotice {
  attempt: number;
  reason: string;
  removed: Array<'image' | 'audio' | 'file' | 'parameter'>;
  replacements: Array<'description' | 'placeholder' | 'parameter_omitted'>;
}

// ── EmaStreamEvent 联合类型 ───────────────────────────────────────────────────

export type EmaStreamEvent =
  // Turn 生命周期
  | {
      type: 'turn_started';
      sessionId: SessionId;
      turnId: TurnId;
      executionProfile: ExecutionProfile;
      narrativePolicy: NarrativePolicy;
    }
  | { type: 'usage_update';   sessionId: SessionId; turnId: TurnId; inputTokens: number; outputTokens: number }
  | { type: 'turn_completed'; sessionId: SessionId; turnId: TurnId; stats: TurnStats }
  | { type: 'turn_failed';    sessionId: SessionId; turnId: TurnId; code: TurnFailureCode; message: string }
  | { type: 'turn_aborted';   sessionId: SessionId; turnId: TurnId; reason: string }
  | {
      type: 'turn_projection_warning';
      sessionId: SessionId;
      turnId: TurnId;
      projection: 'subagent_transcript' | 'turn_audio';
      code: string;
      message: string;
      retryable: boolean;
    }
  | {
      type: 'request_degraded';
      sessionId: SessionId;
      turnId: TurnId;
    } & RequestDegradationNotice

  // 文本流；blockIndex 表示内容在助手块数组中的位置
  | { type: 'output_text_delta';    sessionId: SessionId; blockIndex: number; delta: string }

  // 推理块，包括 DeepSeek-R1 与 Claude 扩展思考
  | { type: 'reasoning_delta';    sessionId: SessionId; blockIndex: number; delta: string }
  | { type: 'reasoning_complete'; sessionId: SessionId; blockIndex: number }

  // 工具调用；blockIndex 告诉前端该工具在内容块列表中的位置
  | { type: 'tool_call_partial';  sessionId: SessionId; blockIndex: number; callId: string; name: string; argsDelta: string }
  | { type: 'tool_call_complete'; sessionId: SessionId; blockIndex: number; callId: string; name: string; args: unknown }
  | { type: 'tool_result';        sessionId: SessionId; callId: string; name: string; output?: unknown; presentation?: ToolPresentation; error?: ToolError; durationMs: number }

  | PermissionStreamEvent

  // 内置 ask_user 工具在 Tauri/SSE 流式环境中发出该事件。
  // 一个事件携带完整问题批次，Orchestrator 等待对应响应接口后才结束工具调用。
  | {
      type: 'ask_user_required';
      sessionId: SessionId;
      turnId: TurnId;
      promptId: string;
      questions: AskUserQuestionSpec[];
      humanDescription?: string;
    }
  | {
      type: 'ask_user_resolved';
      sessionId: SessionId;
      promptId: string;
      /** 以 question.id 为键，值为用户文本或拼接后的选项标签。 */
      answers: Record<string, string>;
    }

  // 常见询问场景使用单用途事件，接口比通用 ask_user 更简单。
  // 所有变体共用同一响应端点，回答键由具体工具实现统一定义。
  | { type: 'ask_confirm_required'; sessionId: SessionId; turnId: TurnId; promptId: string; question: string; humanDescription?: string }
  | { type: 'ask_confirm_resolved'; sessionId: SessionId; promptId: string; confirmed: boolean }
  | { type: 'ask_text_required';    sessionId: SessionId; turnId: TurnId; promptId: string; question: string; humanDescription?: string; placeholder?: string }
  | { type: 'ask_text_resolved';    sessionId: SessionId; promptId: string; text: string }
  | {
      type: 'ask_choice_required';
      sessionId: SessionId;
      turnId: TurnId;
      promptId: string;
      question: string;
      humanDescription?: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
      allowCustom?: boolean;
    }
  | { type: 'ask_choice_resolved'; sessionId: SessionId; promptId: string; selected: string[]; customText?: string }

  // Artifact 事件
  | { type: 'artifact_upserted'; sessionId: SessionId; artifact: Artifact }
  | { type: 'artifact_applied';  sessionId: SessionId; id: ArtifactId }

  | EmotionStreamEvent

  // TTS 音频通过 SSE 传输 Base64 字符串
  | { type: 'tts_chunk';             sessionId: SessionId; turnId: TurnId; audio: string; lipsync?: LipSyncFrame[]; sentenceId: string }
  | { type: 'tts_sentence_complete'; sessionId: SessionId; turnId: TurnId; sentenceId: string }

  // Narrative 事件
  | { type: 'narrative_route_resolved';    sessionId: SessionId; turnId: TurnId; timelines: string[] }
  | { type: 'narrative_timeline_complete'; sessionId: SessionId; turnId: TurnId; timeline: string; charCount: number; snippet: string }
  | { type: 'narrative_timeline_failed'; sessionId: SessionId; turnId: TurnId; timeline: string; code: NarrativeTimelineFailureCode; message: string; retryable: boolean }

  // Turn 范围的 Memory 召回事件；每层完成后立即发送一条
  | {
      type: 'memory_recall_evidence';
      sessionId: SessionId;
      turnId: TurnId;
      executionProfile: ExecutionProfile;
      layer: MemoryRecallLayer;
      report: MemoryRecallLayerReport;
    }

  // Turn 范围的 Context 压缩事件，由 ContextCompactor 写入当前 Turn 流。
  // 事件带 turnId，只能进入该 Turn 的 SSE 通道，不能进入系统事件总线。
  | { type: 'context_compaction_started';   compactionId: CompactionId; sessionId: SessionId; turnId: TurnId; executionProfile: ExecutionProfile; narrativePolicy: NarrativePolicy; beforeTokens: number }
  | { type: 'context_compaction_completed'; compactionId: CompactionId; sessionId: SessionId; turnId: TurnId; executionProfile: ExecutionProfile; narrativePolicy: NarrativePolicy; beforeTokens: number; afterTokens: number; savedTokens: number; durationMs: number }
  | { type: 'context_compaction_failed';    compactionId: CompactionId; sessionId: SessionId; turnId: TurnId; executionProfile: ExecutionProfile; narrativePolicy: NarrativePolicy; error: string; beforeTokens: number; afterTokens: number; durationMs: number }
  | { type: 'context_compaction_skipped';   compactionId: CompactionId; sessionId: SessionId; turnId: TurnId; executionProfile: ExecutionProfile; narrativePolicy: NarrativePolicy; reason: 'hook_aborted'; message: string; beforeTokens: number; afterTokens: number; durationMs: number }

  // 系统范围的 Memory 流水线遥测，由 MemoryTaskRunner 或 MemoryPlanner.initialize 发出
  | { type: 'memory_extraction_started';    sessionId: SessionId; turnId?: TurnId; queueDepth: number }
  | { type: 'memory_extraction_completed';  sessionId: SessionId; nodes: number; edges: number; items: number; lazyQueued: number; durationMs: number }
  | { type: 'memory_extraction_failed';     sessionId: SessionId; error: string }
  | { type: 'memory_index_rebuilt';         backend: string; nodes: number; items: number; durationMs: number }
  // 预留事件，当前尚未发出
  | { type: 'memory_consolidation_started';   nodeCount: number }
  | { type: 'memory_consolidation_completed'; consolidated: number; durationMs: number }
  | { type: 'memory_consolidation_failed';    error: string }
  | { type: 'memory_maintenance_completed'; decayedNodes: number; decayedItems: number; dryRun: boolean; durationMs: number }
  | { type: 'memory_maintenance_failed';    error: string }
  | { type: 'memory_node_merged';           nodeId: string; label: string; fragmentCount: number }

  // 系统范围的 Memory 后台队列遥测
  | { type: 'memory_task_started';   taskId: string; kind: string; sessionId?: SessionId }
  | { type: 'memory_task_completed'; taskId: string; kind: string; durationMs: number }
  | { type: 'memory_task_failed';    taskId: string; kind: string; error: string }

  // 系统范围的知识库导入进度，用于后台文档索引。
  // 设置页全局上传不带 sessionId；聊天拖入的 Session 范围导入后续会补上。
  // progress 是 0 到 1 的进度条比例。
  | { type: 'kb_ingest_progress';  kbId: string; taskId?: string; assetId: string; stage: 'validate' | 'parse' | 'chunk' | 'embed'; progress: number; totalItems?: number; completedItems?: number; failedItems?: number; sessionId?: SessionId }
  | { type: 'kb_ingest_completed'; kbId: string; taskId?: string; assetId: string; sessionId?: SessionId }
  | { type: 'kb_ingest_partial_failed'; kbId: string; taskId?: string; assetId: string; error: string; totalItems: number; completedItems: number; failedItems: number; sessionId?: SessionId }
  | { type: 'kb_ingest_failed';    kbId: string; taskId?: string; assetId: string; error: string; sessionId?: SessionId }

  // 系统范围的知识库重新嵌入进度，用于后台重建索引。
  // 与 ingest 同型; assetId 为 '' 表示终态来自全库扫描而非单个文档。
  | { type: 'kb_reembed_progress';  kbId: string; taskId?: string; assetId: string; progress: number; totalItems?: number; completedItems?: number; failedItems?: number }
  | { type: 'kb_reembed_completed'; kbId: string; taskId?: string; assetId: string; totalItems: number; completedItems: number; failedItems: number }
  | { type: 'kb_reembed_partial_failed'; kbId: string; taskId?: string; assetId: string; error: string; totalItems: number; completedItems: number; failedItems: number }
  | { type: 'kb_reembed_cancelled'; kbId: string; taskId?: string; assetId: string }
  | { type: 'kb_reembed_failed';    kbId: string; taskId?: string; assetId: string; error: string }

  // Agent 事件
  | { type: 'agent_iteration';     sessionId: SessionId; n: number }
  | { type: 'agent_breaker_tripped'; sessionId: SessionId; reason: string }

  // ── 子 Agent 面板事件 ───────────────────────────────────────────────────────
  // 统一由 SubagentSpawner 发出，因此事件能携带模型、耗时和用量。
  // 客户端字段 subagentId 的实际值是 AgentRunId，不再兼作 TurnId。
  | {
      type:           'subagent_started';
      sessionId:      SessionId;
      subagentId:     AgentRunId;
      parentTurnId:   TurnId;
      description?:   string;
      model:          string;
      kind:           AgentKind;
      promptExcerpt:  string;
      startedAtMs:    number;
    }
  | {
      type:          'subagent_progress';
      sessionId:     SessionId;
      subagentId:    AgentRunId;
      iteration:     number;
      elapsedMs:     number;
      toolCallCount: number;
    }
  | {
      type:           'subagent_completed';
      sessionId:      SessionId;
      subagentId:     AgentRunId;
      outputExcerpt:  string;
      iterationCount: number;
      toolCallCount:  number;
      stats:          TurnStats;
    }
  | {
      type:        'subagent_failed';
      sessionId:   SessionId;
      subagentId:  AgentRunId;
      error:       string;
      atIteration: number;
      elapsedMs:   number;
    }
  | {
      type:       'subagent_aborted';
      sessionId:  SessionId;
      subagentId: AgentRunId;
      reason:     string;
      elapsedMs:  number;
    }
  // 高频明细仅在详情面板打开时订阅，并按 subagentId 路由到对应 AgentRun。
  | { type: 'subagent_stream'; sessionId: SessionId; subagentId: AgentRunId; ev: SubagentInnerEvent }

  | ProviderStreamEvent

  // 角色卡事件
  | { type: 'character_card_switched'; cardId: CharacterCardId; name: string }

  // 系统事件
  | {
      type: 'hook_warning';
      sessionId: SessionId;
      turnId: TurnId;
      hookInvocationId: HookInvocationId;
      hookEvent: string;
      handlerName: string;
      severity: 'warn' | 'error';
      failureKind: HookWarningFailureKind;
      message: string;
      timestampMs: number;
      durationMs?: number;
    }
  | { type: 'system_warning'; level: 'info' | 'warn' | 'error'; message: string }

/** 会暂停工具执行并等待用户回答的事件，Registry 用它恢复被重开的窗口。 */
export type AskUserRequiredEvent = Extract<
  EmaStreamEvent,
  {
    type:
      | 'ask_user_required'
      | 'ask_confirm_required'
      | 'ask_text_required'
      | 'ask_choice_required';
  }
>;

export interface PendingAskUserPrompt {
  createdAt: number;
  request: AskUserRequiredEvent;
}
