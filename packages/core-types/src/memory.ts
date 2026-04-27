/**
 * 记忆与召回的核心类型 —— V1 四层记忆模型。
 *
 * 架构分层：
 * - L1 Working Scratchpad：当前回合临时工作台（Agent 专用，不持久化）
 * - L2 Conversation：当前会话消息 + 分层滚动摘要（JSON 持久化）
 * - L3 Session Identity：角色卡、任务描述、策略笔记（JSON 持久化）
 * - L4 User Profile & World Knowledge：跨会话画像 + 剧情/附件知识（SQLite / Python Bridge）
 *
 * 关键原则：
 * 1. 所有记忆最终都必须转换成 ContextBlock，按 priority 排序后注入 system prompt。
 * 2. 原始 user query 永远不被污染（RuntimeInputEnvelope.rawQuery 隔离）。
 * 3. Agent 的 Working Memory 是结构化的，回合结束可丢弃。
 * 4. Narrative 走 Python Bridge（lightrag），TS 侧只做统一格式转换。
 * 5. GraphRAG 模块保留为 P2 占位，V1 不实现检索逻辑。
 *
 * @author EmaAgent Team
 * @since 2026-04-24
 */

// ═══════════════════════════════════════════════════════════════
//  第一节：统一召回层（所有 Mode 共享）
// ═══════════════════════════════════════════════════════════════

/** 上下文来源标识 —— 决定 block 在 system prompt 中的语义角色 */
export type ContextSource =
  | "system_prompt"        // Layer 3: 角色设定、系统指令
  | "rolling_summary"      // Layer 2: 压缩后的会话历史摘要
  | "recent_messages"      // Layer 2: 最近 N 轮原始消息
  | "working_scratchpad"   // Layer 1: Agent 当前工具链/推理草稿
  | "user_profile"         // Layer 4: 跨会话用户偏好/技能/习惯
  | "semantic_fact"        // Layer 4: 外部知识、剧情事实、通用知识
  | "narrative_world"      // Layer 4: 剧情世界观、时间线、角色关系
  | "attachment_chunk"     // 附件召回片段
  | "vision_frame"         // 视觉单帧分析结果
  | "vision_gallery";      // 视觉图库聚合描述

/** 上下文块 —— 所有记忆的最终形态，直接注入 system prompt */
export interface ContextBlock {
  /** 来源标识，用于调试和前端展示 */
  source: ContextSource;
  /** 优先级（budget 不足时按 priority 降序截断） */
  priority: number;
  /** 文本内容 */
  content: string;
  /** Token 估算（由 tokenizer 计算，budget 治理用） */
  tokenEstimate: number;
}

/** 召回统一请求 */
export interface RecallRequest {
  mode: "chat" | "agent" | "narrative";
  sessionId: string;
  /** 当前用户原始 query（仅用于召回判定，不注入 LLM） */
  query: string;
  /** 当前上下文预算（由 Preflight 传入，单位：token） */
  budgetTokens: number;
}

/** 召回统一结果 */
export interface RecallResult {
  blocks: ContextBlock[];
  meta: RecallMeta;
}

/** 召回元信息（用于 metadata 流与前端展示） */
export interface RecallMeta {
  requestId: string;
  /** 召回耗时（毫秒） */
  durationMs: number;
  /** 各来源命中统计 */
  sourceStats: Partial<Record<ContextSource, RecallSourceStat>>;
  /** 总 token 占用 */
  totalTokens: number;
  /** 是否触发压缩 */
  compactionTriggered: boolean;
}

export interface RecallSourceStat {
  /** 命中条数 */
  count: number;
  /** 占用 token 数 */
  tokens: number;
}

// ═══════════════════════════════════════════════════════════════
//  第二节：Chat 模式专用 —— 分层滚动摘要
// ═══════════════════════════════════════════════════════════════

/**
 * 滚动摘要。
 *
 * 与 v0.4 单字符串 current_summary 不同，V1 支持分层：
 * - layer=0 是最新生成的摘要（覆盖最近消息）
 * - layer 越大，摘要越老，粒度越粗
 * - 组装 context 时按 layer 从新到旧拼接
 *
 * 压缩触发：按 token 数（而非消息数），由 session-runtime/tokenizer.ts 计算。
 */
export interface RollingSummary {
  sessionId: string;
  /** 压缩层级（0=最近，越大越老） */
  layer: number;
  /** 压缩后的对话摘要 */
  summaryText: string;
  /** 覆盖了哪些消息范围 */
  coversMessageRange: { fromIndex: number; toIndex: number };
  /** 摘要生成时间 */
  generatedAt: number;
  /** 摘要 token 数（预算治理用） */
  tokenCount: number;
}

// ═══════════════════════════════════════════════════════════════
//  第三节：Agent 模式专用 —— 结构化工作记忆 + 反思沉淀
// ═══════════════════════════════════════════════════════════════

/**
 * Agent 工作记忆（L1）。
 *
 * 内存级对象，不持久化。每轮 Agent Loop（think → act → observe）
 * 在此读写，回合结束后 scratchFacts 清空，toolTraces 保留到 reflect。
 */
export interface AgentWorkingMemory {
  sessionId: string;
  /** 当前回合序号 */
  turnIndex: number;
  /** 本轮目标（由 think 步骤设定） */
  currentGoal?: string;
  /** 已执行工具链（act → observe 追加） */
  toolTraces: ToolTrace[];
  /** 待验证假设 */
  pendingHypotheses: string[];
  /** 本轮临时召回碎片（回合结束可丢弃） */
  scratchFacts: string[];
}

/** 工具调用痕迹 */
export interface ToolTrace {
  toolName: string;
  callId: string;
  input: unknown;
  output: unknown;
  /** 是否成功 */
  success: boolean;
  /** 失败原因（供 reflect 分析） */
  errorReason?: string;
  timestamp: number;
}

/**
 * Agent 反思沉淀（reflect 步骤产出）。
 *
 * 置信度 > 0.7 的 fact 会写入 L4 User Profile，
 * strategyNotes 写入 L3 Session Identity。
 */
export interface ReflectionMemo {
  sessionId: string;
  turnIndex: number;
  /** 从本轮提取的持久事实 */
  extractedFacts: ExtractedFact[];
  /** 策略调整建议（仅当前会话有效） */
  strategyNotes: string[];
  /** 是否已沉淀到 User Profile */
  persistedToProfile: boolean;
}

/** 提取的事实项 */
export interface ExtractedFact {
  content: string;
  /** 置信度（0~1），> 0.7 才沉淀到 L4 */
  confidence: number;
  /** 事实类型 */
  factType: "preference" | "skill" | "habit" | "project";
}

/**
 * Agent 会话级策略档案（L3）。
 *
 * 与 Chat/Narrative 共用 Session Identity，但 Agent 额外维护策略笔记。
 */
export interface AgentSessionIdentity {
  sessionId: string;
  /** 当前任务描述 */
  taskDescription: string;
  /** 相关文件/代码上下文 */
  relevantFiles: string[];
  /** 策略笔记（"下次遇到 X 先用 Y 工具"） */
  strategyNotes: string[];
  lastUpdated: number;
}

// ═══════════════════════════════════════════════════════════════
//  第四节：Narrative 模式专用 —— Python Bridge 桥接
// ═══════════════════════════════════════════════════════════════

/**
 * Narrative 世界观状态（L4 轻量缓存，TS 内存）。
 *
 * 重计算在 Python Bridge（lightrag），TS 侧只保留缓存和桥接参数。
 */
export interface WorldState {
  worldId: string;
  /** 当前时间线位置 */
  currentTimeline: string;
  /** 活跃角色列表 */
  activeCharacters: string[];
  /** 关键剧情标记（如 "Chapter_3_completed"） */
  plotFlags: string[];
  /** 缓存时间戳（用于过期判断） */
  cachedAt: number;
}

/** Python Bridge 查询参数 */
export interface NarrativeBridgeQuery {
  worldId: string;
  /** 当前场景上下文 */
  sceneContext: string;
  /** 查询文本 */
  query: string;
  /** 需要召回的角色（可选过滤） */
  characterIds?: string[];
}

/** Python Bridge 返回结果（lightrag 查询后，TS 侧转换前） */
export interface NarrativeBridgeResult {
  /** 召回文本块（已去重） */
  chunks: Array<{
    text: string;
    relevance: number;
    source: string; // 周目标识，如 "1st_Loop"
  }>;
  /** 是否执行过去重 */
  deduped: boolean;
  /** 查询耗时 */
  durationMs: number;
}

// ═══════════════════════════════════════════════════════════════
//  第五节：跨会话持久层（L4）—— 用户画像
// ═══════════════════════════════════════════════════════════════

/**
 * 用户画像条目（SQLite 表 user_profiles）。
 *
 * V1 假设单机单用户，userId 默认用 device_id 或本地 UUID。
 * 预留字段但不实现多用户逻辑。
 */
export interface UserProfile {
  /** 条目 ID */
  id: string;
  /** 用户标识（V1 默认单用户） */
  userId: string;
  /** 提取时间 */
  extractedAt: number;
  /** 事实类型 */
  factType: "preference" | "skill" | "habit" | "project";
  /** 事实内容 */
  content: string;
  /** 置信度（0~1） */
  confidence: number;
  /** 来源会话 ID */
  sourceSessionId: string;
  /** 提取来源 */
  extractionSource: "agent_reflect" | "chat_summary" | "explicit_feedback";
}

// ═══════════════════════════════════════════════════════════════
//  第六节：视觉召回（V1 新增）
// ═══════════════════════════════════════════════════════════════

/**
 * 视觉记忆块。
 *
 * 视频不做，只做单帧分析和图库聚合描述。
 * 视觉内容通过 vision-runtime 分析后，提取文本描述写入记忆。
 */
export interface VisionMemoryBlock {
  /** 视觉内容 ID（图片 hash 或截图编号） */
  visionId: string;
  /** 描述文本（如 "屏幕上显示 VS Code 编辑器，打开的是 memory.ts"） */
  description: string;
  /** 关联时间 */
  timestamp: number;
  /** 来源类型 */
  source: "screenshot" | "uploaded_image" | "clipboard";
}

// ═══════════════════════════════════════════════════════════════
//  第七节：写入请求（MemoryRuntime.write 用）
// ═══════════════════════════════════════════════════════════════

/** 记忆写入请求 */
export interface MemoryWriteRequest {
  /** 目标层级 */
  targetLayer: "l1_scratchpad" | "l2_conversation" | "l3_identity" | "l4_profile";
  sessionId: string;
  /** 写入内容 */
  payload: unknown;
  /** 写入原因（调试用） */
  reason?: string;
}

// ═══════════════════════════════════════════════════════════════
//  第八节：GraphRAG 占位（P2，V1 不实现检索逻辑）
// ═══════════════════════════════════════════════════════════════

/**
 * GraphRAG 节点定义（P2 占位）。
 *
 * V1 保留 schema 以便后续无缝升级，但 memory-runtime 不调用 GraphRAG 检索。
 */
export interface GraphNodePlaceholder {
  key: string;
  id: string;
  name: string;
  entityType: string;
  summary: string;
  /** 预留：P2 实现时补充 descriptions / mention_count 等字段 */
}

/** GraphRAG 边定义（P2 占位） */
export interface GraphEdgePlaceholder {
  key: string;
  id: string;
  source: string;
  target: string;
  relationType: string;
}
