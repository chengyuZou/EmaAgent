/**
 * SSE 流事件协议 — EmaAgent 前后端实时通信的唯一契约。
 *
 * ## 协议模型
 *
 * 后端在 turn 执行过程中通过 `text/event-stream` 推送结构化事件。
 * 前端 `EventSource` 按 `event.type` 分发到对应渲染处理器。
 *
 * ## 设计约束
 *
 * 1. **自包含** — 每个事件携带渲染所需的全部字段，前端无需回查 API
 * 2. **append-only** — 事件流是单向追加的，前端按到达顺序处理
 * 3. **终态关闭** — 收到 `turn_completed` / `turn_failed` / `turn_cancelled` 后 SSE 连接关闭
 * 4. **严禁日志解析** — 前端永远只消费结构化 event，绝对禁止从日志字符串提取信息
 *
 * ## 事件时序（agent 模式典型流程）
 *
 * ```
 * turn_started
 *   → step_start(thinking) → text_delta* → text_done → step_end(thinking)
 *   → step_start(tool)
 *     → tool_call_start → tool_call_args* → tool_call_end
 *     → [permission_request]  // 仅高风险工具
 *     → tool_result
 *   → step_end(tool)
 *   → tool_call_start → ... → tool_result  // 串行工具逐个执行
 *   → step_start(thinking) → ... (下一轮 ReAct)
 * turn_completed
 * ```
 */

import type {
  ArtifactId,
  ImageGenTaskId,
  MessageId,
  RequestId,
  SessionId,
  StepId,
  SttSessionId,
  ToolCallId,
  UnixMs,
} from "./ids.js"
import type { EmaMode } from "./mode.js"
import type { ArtifactSummary } from "./artifact.js"
import type {
  EmotionTransition,
  GeneratedImage,
  PhonemeTiming,
} from "./multimodal.js"
import type { TurnNotification } from "./notification.js"

// ═══════════════════════════════════════════════════════════════
// 用户回传协议（HTTP POST，非 SSE）
// ═══════════════════════════════════════════════════════════════

/** 用户对权限询问的响应——前端 POST 回 BFF，非 SSE 流内事件。 */
export interface UserPermissionResponse {
  type: "user_permission_response"
  requestId: RequestId
  toolCallId: ToolCallId
  allowed: boolean
}

// ═══════════════════════════════════════════════════════════════
// Event 基类
// ═══════════════════════════════════════════════════════════════

/** 所有 SSE 事件的公共字段。 */
export interface BaseEvent {
  /** 关联的 API 请求 ID——前端据此将事件归属到当前 turn。 */
  requestId: RequestId
  /** 关联的会话 ID。 */
  sessionId: SessionId
  /** 事件生成时间（Unix 毫秒）。 */
  at: UnixMs
}

// ═══════════════════════════════════════════════════════════════
// SseEvent — 顶层联合类型
// ═══════════════════════════════════════════════════════════════

/**
 * 所有可能的 SSE 事件的联合类型。
 *
 * 前端收到事件后，通过 `event.type` 判别并分发到对应渲染器。
 * 后端通过此联合类型确保 emit 的每个事件都有 type 字段的类型安全。
 */
export type SseEvent =
  // --- 生命周期 ---
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | TurnCancelledEvent

  // --- 文本流 ---
  | TextDeltaEvent
  | TextDoneEvent

  // --- 工具调用（ReAct act 阶段）---
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolResultEvent

  // --- 权限请求 ---
  | PermissionRequestEvent

  // --- ReAct 步骤（Agent 模式专用）---
  | StepStartEvent
  | StepProgressEvent
  | StepEndEvent

  // --- 检索（Narrative / Attachment）---
  | RetrievalStartEvent
  | RetrievalDeltaEvent
  | RetrievalEndEvent

  // --- 上下文压缩 ---
  | CompressionNotifyEvent

  // --- 产物 ---
  | ArtifactCreateEvent
  | ArtifactDeltaEvent
  | ArtifactFinalizeEvent

  // --- 媒体 ---
  | ImageEvent

  // --- 舞台提示（Live2D 表情/动作）---
  | StageCueEvent

  // --- TTS（语音合成）---
  | TtsStartedEvent
  | TtsAudioDeltaEvent
  | TtsPhonemeEvent
  | TtsCompletedEvent

  // --- STT（语音识别）---
  | SttStartedEvent
  | SttInterimEvent
  | SttCompletedEvent
  | VadEvent

  // --- 图片生成 ---
  | ImageGenStartedEvent
  | ImageGenProgressEvent
  | ImageGenCompletedEvent

  // --- 情感 ---
  | EmotionChangedEvent

  // --- 音频可视化 ---
  | AudioSpectrumEvent

  // --- 桌面通知 ---
  | NotificationEvent

  // --- 错误 ---
  | ErrorEvent

// ═══════════════════════════════════════════════════════════════
// 生命周期事件
// ═══════════════════════════════════════════════════════════════

/** turn 启动——前端收到后开始渲染助手消息占位。 */
export interface TurnStartedEvent extends BaseEvent {
  type: "turn_started"
  mode: EmaMode
  /** 已落盘的用户消息 ID——前端可据此插入用户消息气泡。 */
  userMessageId: MessageId
  /** 助手消息 ID——后续所有 text_delta / tool 事件归属到此消息。 */
  assistantMessageId: MessageId
}

/** turn 正常完成——前端停止 loading 动画，刷新用量显示。 */
export interface TurnCompletedEvent extends BaseEvent {
  type: "turn_completed"
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    costUsd?: number
  }
}

/** turn 执行失败——前端展示错误信息，启用重试按钮。 */
export interface TurnFailedEvent extends BaseEvent {
  type: "turn_failed"
  /** 稳定错误码，前端据此展示对应 UI 文案。 */
  code: string
  message: string
  retryable: boolean
  /** 失败时已产生的产物 ID 列表（不丢失已完成的工作）。 */
  artifactIds?: ArtifactId[]
}

/** turn 被用户取消——前端停止动画，不显示重试按钮。 */
export interface TurnCancelledEvent extends BaseEvent {
  type: "turn_cancelled"
  /** 取消前最后一步的 stepId（用于 UI 高亮）。 */
  lastStepId?: StepId
}

// ═══════════════════════════════════════════════════════════════
// 文本流事件
// ═══════════════════════════════════════════════════════════════

/** 增量文本片段——前端追加到对应消息气泡末尾。 */
export interface TextDeltaEvent extends BaseEvent {
  type: "text_delta"
  messageId: MessageId
  /** 增量文本（可能是单个 token 或多个字符）。 */
  delta: string
  /** 文本块的稳定标识——一个消息可能有多个文本块（如被 tool_call 分隔）。 */
  blockId: string
}

/** 文本块完成——前端可将 block 标记为完整，用于落盘校验。 */
export interface TextDoneEvent extends BaseEvent {
  type: "text_done"
  messageId: MessageId
  /** 该文本块的完整内容。 */
  fullText: string
  blockId: string
}

// ═══════════════════════════════════════════════════════════════
// 工具调用事件（ReAct act 阶段核心）
// ═══════════════════════════════════════════════════════════════

/** 开始工具调用——前端在消息气泡中插入 tool_call 卡片（状态: running）。 */
export interface ToolCallStartEvent extends BaseEvent {
  type: "tool_call_start"
  messageId: MessageId
  toolCallId: ToolCallId
  toolName: string
  /** 工具来源：local（TS 侧内置工具）或 mcp（MCP 服务器工具）。 */
  source?: "local" | "mcp"
}

/** 工具调用参数增量（流式传递 JSON 片段）。 */
export interface ToolCallArgsEvent extends BaseEvent {
  type: "tool_call_args"
  messageId: MessageId
  toolCallId: ToolCallId
  /** 参数 JSON 增量片段。 */
  argsDelta: string
}

/** 工具调用参数完成——前端展示完整参数。 */
export interface ToolCallEndEvent extends BaseEvent {
  type: "tool_call_end"
  messageId: MessageId
  toolCallId: ToolCallId
  /** 完整解析后的参数对象。 */
  args: Record<string, unknown>
}

/** 工具执行结果——前端更新 tool_call 卡片状态（success / failure）。 */
export interface ToolResultEvent extends BaseEvent {
  type: "tool_result"
  messageId: MessageId
  toolCallId: ToolCallId
  toolName: string
  success: boolean
  /** 工具返回的字符串结果（截断后的预览）。 */
  resultStr: string
  durationMs: number
}

// ═══════════════════════════════════════════════════════════════
// 权限请求
// ═══════════════════════════════════════════════════════════════

/**
 * 权限请求——前端弹出确认对话框。
 *
 * 仅对高风险工具（terminal / code exec / file write）发出。
 * 低风险只读工具（search / read file）无需此事件，直接执行。
 * 用户通过 `POST /api/turns/:id/permission` 回复。
 */
export interface PermissionRequestEvent extends BaseEvent {
  type: "permission_request"
  messageId: MessageId
  toolCallId: ToolCallId
  toolName: string
  /** 人类可读的操作摘要，如 "删除文件 /tmp/test.txt"。 */
  summary: string
  /** 风险级别——前端据此改变确认按钮的颜色和文案。 */
  risk: "low" | "medium" | "high" | "critical"
}

// ═══════════════════════════════════════════════════════════════
// ReAct 步骤事件（Agent 模式专用）
// ═══════════════════════════════════════════════════════════════

/** ReAct 步骤开始——前端在时间线中插入步骤节点。 */
export interface StepStartEvent extends BaseEvent {
  type: "step_start"
  stepId: StepId
  /** 步骤语义类型——前端据此选择图标和颜色。 */
  stepType:
    | "context"           // 上下文组装
    | "thinking"          // LLM 推理（think 阶段）
    | "tool"              // 工具执行（act 阶段）
    | "diff"              // 差异生成
    | "artifact"          // 产物创建
    | "response"          // 最终回复生成
    | "narrative_recall"  // 剧情召回
  title: string
}

/** ReAct 步骤进度——前端更新步骤节点的副文本。 */
export interface StepProgressEvent extends BaseEvent {
  type: "step_progress"
  stepId: StepId
  detail: string
}

/** ReAct 步骤完成——前端标记步骤节点状态。 */
export interface StepEndEvent extends BaseEvent {
  type: "step_end"
  stepId: StepId
  status: "completed" | "failed" | "skipped"
  /** 该步骤产出的产物 ID 列表。 */
  artifactIds?: ArtifactId[]
}

// ═══════════════════════════════════════════════════════════════
// 检索事件（Narrative / Attachment 查询）
// ═══════════════════════════════════════════════════════════════

export interface RetrievalStartEvent extends BaseEvent {
  type: "retrieval_start"
  messageId: MessageId
  /** 检索来源描述：narrative / attachments / memory。 */
  source: string
}

export interface RetrievalDeltaEvent extends BaseEvent {
  type: "retrieval_delta"
  messageId: MessageId
  source: string
  delta: string
}

export interface RetrievalEndEvent extends BaseEvent {
  type: "retrieval_end"
  messageId: MessageId
  content: string
  source: string
}

// ═══════════════════════════════════════════════════════════════
// 压缩通知
// ═══════════════════════════════════════════════════════════════

/** 上下文压缩完成通知——前端可展示"已压缩上下文"提示。 */
export interface CompressionNotifyEvent extends BaseEvent {
  type: "compression_notify"
  messageId: MessageId
  originalTokens: number
  compressedTokens: number
  content: string
}

// ═══════════════════════════════════════════════════════════════
// 产物事件
// ═══════════════════════════════════════════════════════════════

export interface ArtifactCreateEvent extends BaseEvent {
  type: "artifact_create"
  artifactId: ArtifactId
  /** 产物摘要——前端据此渲染列表卡片。 */
  summary: ArtifactSummary
}

export interface ArtifactDeltaEvent extends BaseEvent {
  type: "artifact_delta"
  artifactId: ArtifactId
  delta: string
}

export interface ArtifactFinalizeEvent extends BaseEvent {
  type: "artifact_finalize"
  artifactId: ArtifactId
  summary: ArtifactSummary
}

// ═══════════════════════════════════════════════════════════════
// 媒体事件
// ═══════════════════════════════════════════════════════════════

/** 图片内容——前端在消息气泡中渲染图片。 */
export interface ImageEvent extends BaseEvent {
  type: "image"
  messageId: MessageId
  /** 图片地址（data URL 或本地文件路径）。 */
  url: string
  mimeType?: string
  alt?: string
}

// ═══════════════════════════════════════════════════════════════
// 舞台提示（Live2D 控制）
// ═══════════════════════════════════════════════════════════════

/**
 * Live2D 舞台提示——后端根据当前上下文推断 Ema 应展示的表情和动作。
 *
 * 前端 Live2D 控制器收到此事件后，将队列中的表情/动作应用到模型。
 * 此事件不与任何 messageId 绑定——它是全局的舞台指令。
 */
export interface StageCueEvent extends BaseEvent {
  type: "stage_cue"
  cue: {
    /** 触发源——用于前端决定 cue 的视觉优先级。 */
    source: "act" | "step" | "tool" | "artifact" | "system"
    /** 表情：neutral（默认）、happy（愉悦）、thinking（思考）、sad（悲伤）、surprised（惊讶）、curious（好奇）。 */
    expression?: "neutral" | "curious" | "happy" | "thinking" | "sad" | "surprised"
    /** 动作：idle（待机）、lean_forward（前倾）、nod（点头）、look_left/right（左右看）。 */
    motion?: "idle" | "lean_forward" | "nod" | "look_left" | "look_right"
    /** 口型：idle（闭嘴）、speaking（说话对口型）。 */
    mouth?: "idle" | "speaking"
    /** 优先级——数值越大越优先，用于合并多个 cue。 */
    priority?: number
    /** 持续时间（毫秒），0 表示一次性触发。 */
    durationMs?: number
  }
}

// ═══════════════════════════════════════════════════════════════
// TTS 事件（语音合成流）
// ═══════════════════════════════════════════════════════════════

/** TTS 合成开始——前端初始化音频播放队列和口型调度器。 */
export interface TtsStartedEvent extends BaseEvent {
  type: "tts_started"
  messageId: MessageId
  /** 音频总时长预估值（毫秒），如果 TTS 引擎能提前返回。 */
  estimatedDurationMs?: number
  /** 音频格式——前端据此初始化 AudioContext。 */
  codec: string
  sampleRate: number
  channels: number
}

/** TTS 音频增量块——前端追加到音频缓冲队列并开始解码播放。 */
export interface TtsAudioDeltaEvent extends BaseEvent {
  type: "tts_audio_delta"
  messageId: MessageId
  /** 音频数据（base64 编码）。 */
  audioBase64: string
  /** 块序号（从 0 开始）。 */
  index: number
  /** 该块的时长（毫秒）。 */
  durationMs: number
  /** 该块对应的文本片段（前端可同步高亮字幕）。 */
  textFragment?: string
}

/** TTS 口型时间点——前端调度到 Web Audio 时间线驱动 Live2D 唇形。 */
export interface TtsPhonemeEvent extends BaseEvent {
  type: "tts_phoneme"
  messageId: MessageId
  /** 该批次包含的音素列表（按 startMs 升序）。 */
  phonemes: PhonemeTiming[]
}

/** TTS 合成完成——前端标记语音播放结束。 */
export interface TtsCompletedEvent extends BaseEvent {
  type: "tts_completed"
  messageId: MessageId
  /** 音频总时长（毫秒）。 */
  totalDurationMs: number
}

// ═══════════════════════════════════════════════════════════════
// STT 事件（语音识别流）
// ═══════════════════════════════════════════════════════════════

/** STT 识别开始——前端显示麦克风激活状态。 */
export interface SttStartedEvent extends BaseEvent {
  type: "stt_started"
  sttSessionId: SttSessionId
  /** 前端可据此决定语音输入气泡的样式。 */
  languageHint?: string
}

/** STT 中间识别结果——前端实时展示临时文本（灰色/斜体）。 */
export interface SttInterimEvent extends BaseEvent {
  type: "stt_interim"
  sttSessionId: SttSessionId
  /** 当前临时文本。 */
  text: string
  /** 置信度（0~1）。 */
  confidence: number
  /** 是否为句子开头。 */
  isSentenceStart?: boolean
}

/** STT 最终识别结果——前端替换临时文本为确认文本，提交 turn。 */
export interface SttCompletedEvent extends BaseEvent {
  type: "stt_completed"
  sttSessionId: SttSessionId
  /** 最终确认文本。 */
  text: string
  /** 置信度（0~1）。 */
  confidence: number
  /** 备选结果。 */
  alternatives?: Array<{ text: string; confidence: number }>
  /** 检测到的语言。 */
  detectedLanguage?: string
  /** 音频时长（毫秒）。 */
  audioDurationMs: number
}

/** VAD 事件——语音活动检测状态变化（前端据此切换麦克风图标）。 */
export interface VadEvent extends BaseEvent {
  type: "vad"
  sttSessionId: SttSessionId
  /** VAD 状态：speech_start / speech_end / silence_timeout。 */
  vadStatus: "speech_start" | "speech_end" | "silence_timeout"
  /** 触发时的音频位置（毫秒）。 */
  audioPositionMs: number
}

// ═══════════════════════════════════════════════════════════════
// 图片生成事件
// ═══════════════════════════════════════════════════════════════

/** 图片生成开始——前端在消息气泡中插入生成卡片（状态: generating）。 */
export interface ImageGenStartedEvent extends BaseEvent {
  type: "image_gen_started"
  messageId: MessageId
  taskId: ImageGenTaskId
  /** 原始提示词（前端展示用）。 */
  prompt: string
}

/** 图片生成进度——前端更新进度条或预览图。 */
export interface ImageGenProgressEvent extends BaseEvent {
  type: "image_gen_progress"
  messageId: MessageId
  taskId: ImageGenTaskId
  progress: number
  stage?: string
  /** 中间预览图（base64，低分辨率）。 */
  previewBase64?: string
}

/** 图片生成完成——前端展示完整图片。 */
export interface ImageGenCompletedEvent extends BaseEvent {
  type: "image_gen_completed"
  messageId: MessageId
  taskId: ImageGenTaskId
  images: GeneratedImage[]
  /** 修正后的提示词。 */
  revisedPrompt?: string
}

// ═══════════════════════════════════════════════════════════════
// 情感事件
// ═══════════════════════════════════════════════════════════════

/**
 * 情感变化事件——Ema 的情感状态发生改变。
 *
 * 前端 Live2D 控制器收到后：
 * 1. 根据 from/to 做表情平滑过渡
 * 2. 在对话气泡旁显示情感变化提示（可选）
 * 3. 更新角色姿态（兴奋→前倾，害羞→低头，自信→挺胸）
 */
export interface EmotionChangedEvent extends BaseEvent {
  type: "emotion_changed"
  /** VAD 过渡数据。 */
  transition: EmotionTransition
}

// ═══════════════════════════════════════════════════════════════
// 音频可视化事件
// ═══════════════════════════════════════════════════════════════

/**
 * 音频频谱快照——驱动 Live2D 舞台背景 EQ 效果。
 *
 * 在 TTS 播放期间按 ~30fps 推送，前端用于：
 * - 舞台背景柔和光效（低频驱动）
 * - 粒子系统（中频驱动）
 * - 高亮闪烁（高频驱动）
 */
export interface AudioSpectrumEvent extends BaseEvent {
  type: "audio_spectrum"
  messageId: MessageId
  /** 低频能量（20~250Hz）。 */
  low: number
  /** 中频能量（250~2000Hz）。 */
  mid: number
  /** 高频能量（2000~20000Hz）。 */
  high: number
  /** 总体音量 RMS（0~1）。 */
  rms: number
  /** 峰值音量（0~1）。 */
  peak: number
}

// ═══════════════════════════════════════════════════════════════
// 桌面通知事件

/**
 * 桌面通知——BFF 在执行关键动作时同步推送。
 *
 * 与 content block 渲染解耦：
 * - 同一动作既产生 tool_start / rag_done / image_gen 等 render block
 * - 也产生一条 NotificationEvent 用于 OS 原生 toast
 *
 * 前端 EventSource 收到后调用 Tauri notification API 弹桌面提示。
 */
export interface NotificationEvent extends BaseEvent {
  type: "notification"
  notification: TurnNotification
}

// ═══════════════════════════════════════════════════════════════
// 错误事件（流内）
// ═══════════════════════════════════════════════════════════════

/** 流内错误——不中断 SSE 连接，前端展示内联错误提示。 */
export interface ErrorEvent extends BaseEvent {
  type: "error"
  code: string
  message: string
  retryable: boolean
}
