/**
 * 多模态常量 — 音频、图片、情感、Live2D 的枚举值全集。
 */

import type {
  AudioCodec,
  AudioSampleRate,
  AudioChannels,
  VoiceEmotion,
  ImageGenStyle,
  ImageGenSize,
  ImageGenQuality,
  EmotionLabel,
  ModerationCategory,
  Live2DExpression,
  Live2DMotion,
  Live2DMouth,
  BreathLevel,
  PhonemeSymbol,
} from "@ema-agent/core-types"

// ═══════════════════════════════════════════════════════════════
// 音频
// ═══════════════════════════════════════════════════════════════

export const AUDIO_CODECS = ["pcm_s16le", "mp3", "ogg_vorbis", "wav", "aac", "opus"] as const satisfies readonly AudioCodec[]

export const AUDIO_SAMPLE_RATES = [8000, 16000, 22050, 24000, 44100, 48000] as const satisfies readonly AudioSampleRate[]

export const AUDIO_CHANNELS = [1, 2] as const satisfies readonly AudioChannels[]

/** TTS 输出格式全集。 */
export const TTS_RESPONSE_FORMATS = ["mp3", "wav", "ogg", "opus", "pcm"] as const

// ═══════════════════════════════════════════════════════════════
// 语音
// ═══════════════════════════════════════════════════════════════

export const VOICE_EMOTIONS = [
  "neutral",
  "happy",
  "sad",
  "angry",
  "fearful",
  "surprised",
  "gentle",
  "excited",
  "whisper",
  "serious",
] as const satisfies readonly VoiceEmotion[]

// ═══════════════════════════════════════════════════════════════
// 图片生成
// ═══════════════════════════════════════════════════════════════

export const IMAGE_GEN_STYLES = [
  "natural",
  "anime",
  "digital_art",
  "oil_painting",
  "watercolor",
  "sketch",
  "pixel_art",
  "3d_render",
  "fantasy",
  "cyberpunk",
] as const satisfies readonly ImageGenStyle[]

export const IMAGE_GEN_SIZES = [
  "256x256",
  "512x512",
  "1024x1024",
  "1024x1792",
  "1792x1024",
  "custom",
] as const satisfies readonly ImageGenSize[]

export const IMAGE_GEN_QUALITIES = ["standard", "hd", "ultra"] as const satisfies readonly ImageGenQuality[]

/** DALL-E 默认参数。 */
export const IMAGE_GEN_DEFAULTS = {
  size: "1024x1024" as const,
  quality: "standard" as const,
  n: 1,
  mimeType: "image/png" as const,
}

// ═══════════════════════════════════════════════════════════════
// 情感 (VAD)
// ═══════════════════════════════════════════════════════════════

export const EMOTION_LABELS = [
  "neutral",
  "happy",
  "sad",
  "angry",
  "fearful",
  "surprised",
  "disgusted",
  "curious",
  "excited",
  "calm",
  "anxious",
  "confident",
  "shy",
  "bored",
  "confused",
  "loving",
  "playful",
  "serious",
] as const satisfies readonly EmotionLabel[]

export const MODERATION_CATEGORIES = [
  "hate",
  "harassment",
  "violence",
  "self_harm",
  "sexual",
  "sexual_minors",
  "illegal",
  "personal_info",
  "spam",
] as const satisfies readonly ModerationCategory[]

// ═══════════════════════════════════════════════════════════════
// Live2D
// ═══════════════════════════════════════════════════════════════

export const LIVE2D_EXPRESSIONS = [
  "neutral",
  "happy",
  "sad",
  "angry",
  "surprised",
  "curious",
  "shy",
  "sleepy",
  "worried",
  "determined",
  "blush",
  "wink",
] as const satisfies readonly Live2DExpression[]

export const LIVE2D_MOTIONS = [
  "idle",
  "idle_alt1",
  "idle_alt2",
  "idle_alt3",
  "lean_forward",
  "lean_back",
  "nod",
  "shake_head",
  "tilt_head_left",
  "tilt_head_right",
  "look_left",
  "look_right",
  "look_up",
  "look_down",
  "wave",
  "clap",
  "point",
  "stretch",
  "yawn",
  "bounce",
  "spin",
] as const satisfies readonly Live2DMotion[]

export const LIVE2D_MOUTH_MODES = ["idle", "speaking", "smile", "open", "pout"] as const satisfies readonly Live2DMouth[]

export const BREATH_LEVELS = ["none", "light", "normal", "heavy"] as const satisfies readonly BreathLevel[]

// ═══════════════════════════════════════════════════════════════
// 口型同步
// ═══════════════════════════════════════════════════════════════

/** 所有音素符号（Live2D 日语音素 + ARPABET 英文 + 静音）。 */
export const PHONEME_SYMBOLS = [
  "A", "I", "U", "E", "O",
  "N", "M", "P", "B", "F", "T", "S", "K", "R",
  "AA", "AE", "AH", "AO", "AW", "AY",
  "EH", "ER", "EY", "IH", "IY",
  "OW", "OY", "UH", "UW",
  "W", "Y",
  "CH", "DH", "JH", "SH", "TH", "ZH",
  "SIL",
] as const satisfies readonly PhonemeSymbol[]

/** 每个音节的估算时长（毫秒）——用于启发式口型映射。 */
export const PHONEME_DURATION_MS = {
  cnSyllable: 200,
  enPhoneme: 120,
  wordBoundary: 80,
} as const

/** 标点 → 静音时长（毫秒）。 */
export const PAUSE_DURATION_MS: Record<string, number> = {
  "。": 400, ".": 400, "！": 300, "!": 300, "？": 300, "?": 300,
  "；": 200, ";": 200, "：": 200, ":": 200, "，": 150, ",": 150,
  "…": 400, "——": 300, "\n": 300,
}
