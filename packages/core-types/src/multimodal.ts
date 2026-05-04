/**
 * 多模态协议 — TTS / STT / 图片生成 / 视觉 / 情感 / 口型同步。
 *
 * EmaAgent 的完整多模态能力层。所有模态类型集中定义在此，
 * 通过 SSE 事件流（event.ts）和 LLM 底层协议（model.ts）与前后端对接。
 *
 * ## 模态管线
 *
 * ```
 * TTS:  Text → VoiceProfile → TTS Engine → AudioChunks + PhonemeTimeline
 *       → SSE: tts_started → tts_audio_delta* → tts_phoneme* → tts_completed
 *       → Live2D LipSync + Audio Playback
 *
 * STT:  Microphone → VAD → STT Engine → InterimResults → FinalTranscript
 *       → SSE: stt_started → stt_interim* → stt_completed
 *       → Turn Input
 *
 * IMG:  Prompt → ImageGen Engine → Progress → Generated Image
 *       → SSE: image_gen_started → image_gen_progress* → image_gen_completed
 *       → Artifact / Chat Message
 *
 * VISION: Image + Instruction → Vision Model → Analysis
 *       → Chat Context / Tool Result
 * ```
 */

import type {
  ImageGenTaskId,
  SttSessionId,
  UnixMs,
  VoiceId,
} from "./ids.js"

// ═══════════════════════════════════════════════════════════════
// 音频格式
// ═══════════════════════════════════════════════════════════════

/** 音频编码格式。 */
export type AudioCodec = "pcm_s16le" | "mp3" | "ogg_vorbis" | "wav" | "aac" | "opus"

/** 音频采样率（Hz）。 */
export type AudioSampleRate = 8000 | 16000 | 22050 | 24000 | 44100 | 48000

/** 音频声道数。 */
export type AudioChannels = 1 | 2

/** 音频流的基础元数据——TTS 输出和 STT 输入共用。 */
export interface AudioFormat {
  codec: AudioCodec
  sampleRate: AudioSampleRate
  channels: AudioChannels
  /** 比特率（bps），可选——用于 MP3/AAC 等有损格式。 */
  bitrate?: number
}

// ═══════════════════════════════════════════════════════════════
// 语音配置（TTS 角色语音）
// ═══════════════════════════════════════════════════════════════

/** 语音的情感色彩——叠加在基础音色上的表现力调整。 */
export type VoiceEmotion =
  | "neutral"
  | "happy"
  | "sad"
  | "angry"
  | "fearful"
  | "surprised"
  | "gentle"
  | "excited"
  | "whisper"
  | "serious"

/**
 * TTS 语音配置文件——定义角色的声音特征。
 *
 * @example
 * // Ema 的默认语音
 * const emaVoice: VoiceProfile = {
 *   id: asId<VoiceId>("voice_ema_default"),
 *   name: "Ema 默认",
 *   engine: "openai",
 *   voiceModel: "shimmer",
 *   pitch: 1.1,
 *   speed: 1.0,
 *   defaultEmotion: "gentle",
 *   audioFormat: { codec: "mp3", sampleRate: 24000, channels: 1 },
 * }
 */
export interface VoiceProfile {
  id: VoiceId
  /** 展示名称，如 "Ema 默认"、"Ema 兴奋"。 */
  name: string
  /** TTS 引擎标识：openai / elevenlabs / edge / vits / fish-speech。 */
  engine: string
  /** 引擎内的语音模型 ID，如 OpenAI 的 "shimmer"、VITS 的模型名。 */
  voiceModel: string
  /** 音调偏移（0.5~2.0，1.0 为默认）。 */
  pitch: number
  /** 语速倍率（0.5~2.0，1.0 为默认）。 */
  speed: number
  /** 默认情感——不指定时使用。 */
  defaultEmotion: VoiceEmotion
  /** 该语音期望的音频输出格式。 */
  audioFormat: AudioFormat
  /** 是否为系统预设（false 表示用户自定义）。 */
  preset?: boolean
  createdAt?: UnixMs
}

// ═══════════════════════════════════════════════════════════════
// TTS（Text-to-Speech）
// ═══════════════════════════════════════════════════════════════

/** TTS 流式响应中的单个音频块。 */
export interface TtsAudioChunk {
  /** 块序号（从 0 开始）。 */
  index: number
  /** 音频二进制数据（base64 编码——SSE 只传文本）。 */
  audioBase64: string
  /** 该块的时长（毫秒）。 */
  durationMs: number
  /** 该块对应的文本片段（用于前端同步高亮字幕）。 */
  textFragment?: string
}

// ═══════════════════════════════════════════════════════════════
// 口型同步（Live2D LipSync 驱动数据）
// ═══════════════════════════════════════════════════════════════

/**
 * 音素符号——Live2D 标准口型参数。
 *
 * Live2D Cubism 使用这些音素来驱动 ParamMouthOpenY 等参数。
 * 不同 TTS 引擎返回不同音素集，前端做映射。
 */
export type PhonemeSymbol =
  // Live2D 标准音素（日语五十音系）
  | "A" | "I" | "U" | "E" | "O"
  // 扩展辅音
  | "N"   // ん/拨音（闭嘴）
  | "M"   // ま行（闭唇）
  | "P"   // ぱ行（爆破闭唇）
  | "B"   // ば行
  | "F"   // ふ（唇齿）
  | "T"   // た行（齿音）
  | "S"   // さ行（齿擦音）
  | "K"   // か行（软腭）
  | "R"   // ら行（弹舌）
  // 英文扩展（如果 TTS 引擎输出）
  | "AA"  // father
  | "AE"  // cat
  | "AH"  // cut
  | "AO"  // dog
  | "AW"  // cow
  | "AY"  // eye
  | "EH"  // bed
  | "ER"  // bird
  | "EY"  // say
  | "IH"  // bit
  | "IY"  // beet
  | "OW"  // boat
  | "OY"  // boy
  | "UH"  // book
  | "UW"  // boot
  | "W"   // way
  | "Y"   // yet
  | "CH"  // church
  | "DH"  // this
  | "JH"  // judge
  | "SH"  // she
  | "TH"  // thin
  | "ZH"  // measure
  // 静音
  | "SIL" // silence / pause

/**
 * 单个口型时间点——驱动 Live2D 的唇形参数。
 *
 * 前端收到后调度到 Web Audio 时间线上，
 * 在指定毫秒设置对应的口型参数。
 */
export interface PhonemeTiming {
  /** 音素符号。 */
  phoneme: PhonemeSymbol
  /** 该音素在音频中的起始时间（毫秒，相对于 TTS 音频开始）。 */
  startMs: number
  /** 该音素在音频中的结束时间（毫秒）。 */
  endMs: number
  /** 口型张开程度（0~1），TTS 引擎可返回，前端也可基于 phoneme 映射。 */
  openness?: number
}

/**
 * 完整的口型时间线——覆盖整段 TTS 音频。
 */
export interface PhonemeTimeline {
  /** 音素序列（按 startMs 升序）。 */
  phonemes: PhonemeTiming[]
  /** 音频总时长（毫秒）。 */
  totalDurationMs: number
  /** 音素数据来源（TTS 引擎直接返回 / 前端从音频分析得出）。 */
  source: "tts_engine" | "audio_analysis" | "estimated"
}

// ═══════════════════════════════════════════════════════════════
// STT（Speech-to-Text）
// ═══════════════════════════════════════════════════════════════

/** STT 中间识别结果——前端实时展示临时文本。 */
export interface SttInterimResult {
  sttSessionId: SttSessionId
  /** 当前已识别但尚未确认的文本。 */
  text: string
  /** 置信度（0~1）。 */
  confidence: number
  /** 是否为句子开头（前端据此决定是否换行）。 */
  isSentenceStart?: boolean
  at: UnixMs
}

/** STT 最终识别结果——前端替换临时文本为最终文本。 */
export interface SttFinalResult {
  sttSessionId: SttSessionId
  /** 最终确认的文本。 */
  text: string
  /** 置信度（0~1）。 */
  confidence: number
  /** 备选识别结果（按置信度降序）。 */
  alternatives?: Array<{ text: string; confidence: number }>
  /** 检测到的语言（BCP-47）。 */
  detectedLanguage?: string
  /** 音频时长（毫秒）。 */
  audioDurationMs: number
  at: UnixMs
}

/** VAD 状态变化——语音活动检测的状态变化通知（非 SSE 事件）。 */
export interface VadStateChange {
  type: "speech_start" | "speech_end" | "silence_timeout"
  at: UnixMs
  /** 触发时的音频位置（毫秒）。 */
  audioPositionMs: number
}

// ═══════════════════════════════════════════════════════════════
// 图片生成
// ═══════════════════════════════════════════════════════════════

/** 图片生成的目标风格。 */
export type ImageGenStyle =
  | "natural"         // 写实照片
  | "anime"           // 二次元动漫
  | "digital_art"     // 数字插画
  | "oil_painting"    // 油画
  | "watercolor"      // 水彩
  | "sketch"          // 素描
  | "pixel_art"       // 像素风
  | "3d_render"       // 3D 渲染
  | "fantasy"         // 奇幻
  | "cyberpunk"       // 赛博朋克

/** 图片尺寸预设。 */
export type ImageGenSize =
  | "256x256"
  | "512x512"
  | "1024x1024"
  | "1024x1792"     // 竖版 9:16
  | "1792x1024"     // 横版 16:9
  | "custom"

/** 图片生成质量。 */
export type ImageGenQuality = "standard" | "hd" | "ultra"

/** 图片生成的进度事件数据。 */
export interface ImageGenProgress {
  taskId: ImageGenTaskId
  /** 进度百分比（0~100）。 */
  progress: number
  /** 当前阶段描述，如 "encoding_prompt"、"generating"、"refining"。 */
  stage?: string
  /** 预览图（base64，低分辨率中间产物）。 */
  previewBase64?: string
}

/** 单张生成图片的结果。 */
export interface GeneratedImage {
  /** 图片 URL 或 base64 DataURL。 */
  url: string
  /** 图片的 base64 编码（小图直接内联，大图走 url）。 */
  base64?: string
  /** MIME 类型。 */
  mimeType: string
  /** 宽度（像素）。 */
  width: number
  /** 高度（像素）。 */
  height: number
  /** 修正后的提示词（DALL-E 等会自动改写 prompt）。 */
  revisedPrompt?: string
  /** 实际种子值。 */
  seed?: number
}

// ═══════════════════════════════════════════════════════════════
// 视觉分析
// ═══════════════════════════════════════════════════════════════

/** 物体检测框——图像中识别到的物体位置。 */
export interface VisionBoundingBox {
  label: string
  confidence: number
  x: number
  y: number
  width: number
  height: number
}

// ═══════════════════════════════════════════════════════════════
// 情感系统（Valence-Arousal-Dominance 模型）
// ═══════════════════════════════════════════════════════════════

/**
 * 情感三维坐标——Valence-Arousal-Dominance (VAD) 模型。
 *
 * 这是心理学中最广泛使用的情感维度模型：
 * - Valence（效价）：愉悦 → 不悦（1.0 = 极愉悦，-1.0 = 极不悦）
 * - Arousal（唤醒度）：兴奋 → 平静（1.0 = 极兴奋，-1.0 = 极平静）
 * - Dominance（支配感）：掌控 → 顺从（1.0 = 极强掌控，-1.0 = 极顺从）
 *
 * @example
 * // "开心"的情感坐标
 * const happy: EmotionVad = { valence: 0.8, arousal: 0.6, dominance: 0.4 }
 *
 * // "悲伤"的情感坐标
 * const sad: EmotionVad = { valence: -0.7, arousal: -0.3, dominance: -0.5 }
 */
export interface EmotionVad {
  valence: number
  arousal: number
  dominance: number
}

/**
 * 离散情感标签——VAD 坐标的人类可读映射。
 *
 * 主要用于 UI 展示和用户偏好设置。
 * 内部计算使用 VAD 坐标，标签是 VAD 空间中的命名区域。
 */
export type EmotionLabel =
  | "neutral"
  | "happy"
  | "sad"
  | "angry"
  | "fearful"
  | "surprised"
  | "disgusted"
  | "curious"
  | "excited"
  | "calm"
  | "anxious"
  | "confident"
  | "shy"
  | "bored"
  | "confused"
  | "loving"
  | "playful"
  | "serious"

/**
 * Ema 的即时情感状态——驱动 Live2D 表情和对话风格。
 *
 * @example
 * // 当前情感快照
 * const emaMood: EmotionState = {
 *   vad: { valence: 0.7, arousal: 0.4, dominance: 0.3 },
 *   label: "happy",
 *   confidence: 0.85,
 *   triggers: [{ source: "user_message", reason: "用户说'你真可爱'", weight: 0.6 }],
 *   since: 1714800000000,
 * }
 */
export interface EmotionState {
  /** VAD 三维坐标。 */
  vad: EmotionVad
  /** 最近似的情感标签。 */
  label: EmotionLabel
  /** 标签分类的置信度（0~1）。 */
  confidence: number
  /** 触发当前情感的来源列表（可能有多个叠加）。 */
  triggers: EmotionTrigger[]
  /** 情感生效时间。 */
  since: UnixMs
  /** 预计持续时间（毫秒），0 表示持久直到下一次触发。 */
  durationMs?: number
}

/** 情感触发源——记录是什么导致了 Ema 的情感变化。 */
export interface EmotionTrigger {
  /** 触发来源类型。 */
  source:
    | "user_message"       // 用户消息内容
    | "user_action"        // 用户操作（点赞、拍头等交互）
    | "tool_result"        // 工具执行结果
    | "narrative_event"    // 剧情事件
    | "time_of_day"        // 时间（如深夜→困倦）
    | "system"             // 系统事件（错误、提醒等）
    | "idle"               // 闲置过久
  /** 人类可读的触发原因。 */
  reason: string
  /** 触发权重（0~1），多个 trigger 叠加时按权重混合。 */
  weight: number
}

/**
 * 情感变化事件数据——用于 SSE 推送和前端 Live2D 表情切换。
 */
export interface EmotionTransition {
  from: EmotionVad
  to: EmotionVad
  /** 过渡持续时间（毫秒）——前端用于平滑插值。 */
  transitionMs: number
  /** 新情感标签。 */
  label: EmotionLabel
  trigger: EmotionTrigger
}

// ═══════════════════════════════════════════════════════════════
// Live2D 动作/手势（增强版）
// ═══════════════════════════════════════════════════════════════

/** Live2D 标准表情键——映射到 Cubism 参数。 */
export type Live2DExpression =
  | "neutral"
  | "happy"
  | "sad"
  | "angry"
  | "surprised"
  | "curious"
  | "shy"
  | "sleepy"
  | "worried"
  | "determined"
  | "blush"
  | "wink"

/** Live2D 标准动作键。 */
export type Live2DMotion =
  | "idle"
  | "idle_alt1"
  | "idle_alt2"
  | "idle_alt3"
  | "lean_forward"
  | "lean_back"
  | "nod"
  | "shake_head"
  | "tilt_head_left"
  | "tilt_head_right"
  | "look_left"
  | "look_right"
  | "look_up"
  | "look_down"
  | "wave"
  | "clap"
  | "point"
  | "stretch"
  | "yawn"
  | "bounce"
  | "spin"

/** Live2D 口型模式。 */
export type Live2DMouth =
  | "idle"       // 闭嘴
  | "speaking"   // 说话对口型（基于 PhonemeTimeline）
  | "smile"      // 微笑
  | "open"       // 张嘴（惊讶等）
  | "pout"       // 噘嘴

/** Live2D 呼吸强度级别。 */
export type BreathLevel = "none" | "light" | "normal" | "heavy"

// ═══════════════════════════════════════════════════════════════
// 音频可视化（Live2D 舞台 EQ 效果）
// ═══════════════════════════════════════════════════════════════

/**
 * 音频频谱快照——驱动 Live2D 舞台背景的 EQ 可视化。
 */
export interface AudioSpectrumSnapshot {
  /** 低频能量（20~250Hz）——驱动舞台柔和光效。 */
  low: number
  /** 中频能量（250~2000Hz）——驱动粒子系统。 */
  mid: number
  /** 高频能量（2000~20000Hz）——驱动高亮闪烁。 */
  high: number
  /** 总体音量 RMS（0~1）。 */
  rms: number
  /** 峰值音量（0~1）。 */
  peak: number
  at: UnixMs
}

// ═══════════════════════════════════════════════════════════════
// 内容审核
// ═══════════════════════════════════════════════════════════════

/** 审核类别。 */
export type ModerationCategory =
  | "hate"
  | "harassment"
  | "violence"
  | "self_harm"
  | "sexual"
  | "sexual_minors"
  | "illegal"
  | "personal_info"
  | "spam"

/** 审核标记——单项违规详情。 */
export interface ModerationFlag {
  category: ModerationCategory
  /** 是否违规。 */
  flagged: boolean
  /** 置信度（0~1）。 */
  confidence: number
}

// ═══════════════════════════════════════════════════════════════
// 视频（V2+）
// ═══════════════════════════════════════════════════════════════

/** 视频帧——用于 Live2D 背景或聊天中的视频内容。 */
export interface VideoFrame {
  index: number
  /** 帧的 base64 编码。 */
  base64: string
  /** 该帧在视频中的时间戳（毫秒）。 */
  timestampMs: number
  mimeType: string
}

// ═══════════════════════════════════════════════════════════════
// VAD → 情感标签映射（CLAUDE.md 定义的内部规则参考）
// ═══════════════════════════════════════════════════════════════

/**
 * 将 VAD 坐标映射到最近的情感标签。
 *
 * 此函数为纯工具函数，在 emotion 能力模块中实现。
 * 类型签名保留在此以明确契约。
 */
export type EmotionClassifier = (vad: EmotionVad) => { label: EmotionLabel; confidence: number }

/**
 * 将情感标签映射到 VAD 空间的原型点。
 *
 * 每个情感标签在 VAD 空间中有一个"原型坐标"，
 * 实际情感坐标围绕原型点分布。
 */
export type EmotionPrototypes = Record<EmotionLabel, EmotionVad>
