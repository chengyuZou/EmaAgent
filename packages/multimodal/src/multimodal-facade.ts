/**
 * MultimodalFacade — 多模态能力的唯一入口。
 *
 * 所有 TTS / STT / ImageGen / Vision / Emotion / Phoneme 能力
 * 必须通过此 Façade 访问，禁止跨包直接调用 adapter 内部实现。
 */

import type {
  EmotionTransition,
  EmotionTrigger,
  GeneratedImage,
  ImageGenRequest,
  PhonemeTimeline,
  SttRequest,
  TtsAudioChunk,
  TtsRequest,
  VoiceId,
  VoiceProfile,
} from "@ema-agent/core-types"

// ═══════════════════════════════════════════════════════════════
// SSE 事件窄类型（仅 multimodal 相关）
// ═══════════════════════════════════════════════════════════════

/** TTS 流式输出的 SSE 事件联合。 */
export type TtsSseEvent =
  | { type: "tts_started"; estimatedDurationMs?: number; codec: string; sampleRate: number; channels: number }
  | { type: "tts_audio_delta"; audioBase64: string; index: number; durationMs: number; textFragment?: string }
  | { type: "tts_phoneme"; phonemes: import("@ema-agent/core-types").PhonemeTiming[] }
  | { type: "tts_completed"; totalDurationMs: number }

/** STT 流式输出的 SSE 事件联合。 */
export type SttSseEvent =
  | { type: "stt_started"; sttSessionId: string; languageHint?: string }
  | { type: "stt_interim"; sttSessionId: string; text: string; confidence: number }
  | { type: "vad"; sttSessionId: string; vadStatus: "speech_start" | "speech_end" | "silence_timeout"; audioPositionMs: number }
  | { type: "stt_completed"; sttSessionId: string; text: string; confidence: number; detectedLanguage?: string; audioDurationMs: number }

/** ImageGen 流式输出的 SSE 事件联合。 */
export type ImageGenSseEvent =
  | { type: "image_gen_started"; taskId: string; prompt: string }
  | { type: "image_gen_progress"; taskId: string; progress: number; stage?: string; previewBase64?: string }
  | { type: "image_gen_completed"; taskId: string; images: GeneratedImage[]; revisedPrompt?: string }

// ═══════════════════════════════════════════════════════════════
// Façade 接口
// ═══════════════════════════════════════════════════════════════

export interface MultimodalFacade {
  // ---- TTS ----
  /** 流式语音合成。返回 AsyncIterable，BFF 层逐条转 SSE。 */
  synthesizeSpeech(req: TtsRequest): AsyncIterable<TtsSseEvent>
  /** 列举可用语音配置。 */
  listVoices(engine?: string): Promise<VoiceProfile[]>
  /** 获取单个语音配置。 */
  getVoice(id: VoiceId): Promise<VoiceProfile | undefined>

  // ---- STT ----
  /** 流式语音识别。消费音频流，产出识别事件。 */
  transcribeSpeech(req: SttRequest): AsyncIterable<SttSseEvent>

  // ---- Image Gen ----
  /** 流式图片生成。 */
  generateImage(req: ImageGenRequest): AsyncIterable<ImageGenSseEvent>

  // ---- Emotion ----
  /** 分析文本，计算情感过渡。 */
  analyzeEmotion(text: string, currentEmotion?: EmotionTransition["from"], triggers?: EmotionTrigger[]): Promise<EmotionTransition>

  // ---- Phoneme ----
  /** 根据文本和语音配置，构建完整口型时间线。 */
  buildPhonemeTimeline(text: string, voice: VoiceProfile): Promise<PhonemeTimeline>
}

// ═══════════════════════════════════════════════════════════════
// Adapter 接口（内部使用，不对外暴露）
// ═══════════════════════════════════════════════════════════════

export interface TtsAdapter {
  readonly engine: string
  synthesize(req: TtsRequest): AsyncIterable<TtsAudioChunk>
  buildPhonemeTimeline(text: string, voice: VoiceProfile): Promise<PhonemeTimeline>
  listVoices(): Promise<VoiceProfile[]>
}

export interface SttAdapter {
  readonly engine: string
  transcribe(req: SttRequest): AsyncIterable<{
    type: "interim" | "final" | "vad"
    text?: string
    confidence?: number
    detectedLanguage?: string
    audioDurationMs?: number
    vadStatus?: "speech_start" | "speech_end" | "silence_timeout"
    audioPositionMs?: number
  }>
}

export interface ImageGenAdapter {
  readonly engine: string
  generate(req: ImageGenRequest): AsyncIterable<{
    type: "progress" | "complete"
    progress?: number
    stage?: string
    previewBase64?: string
    images?: GeneratedImage[]
    revisedPrompt?: string
  }>
}
