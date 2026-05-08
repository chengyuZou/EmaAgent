/**
 * TTS Adapter 实现 — OpenAI TTS API。
 *
 * POST https://api.openai.com/v1/audio/speech
 * 返回完整音频（非流式），客户端自行分块推 SSE。
 */

import type { TtsAudioChunk, TtsRequest, VoiceProfile } from "@ema-agent/core-types"
import type { TtsAdapter } from "../../multimodal-facade.js"

export class OpenAITtsAdapter implements TtsAdapter {
  readonly engine = "openai"

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {}

  async *synthesize(req: TtsRequest): AsyncIterable<TtsAudioChunk> {
    const response = await fetch(`${this.baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: req.modelId,
        input: req.text,
        voice: req.voiceId ?? "shimmer",
        speed: req.speed ?? 1.0,
        response_format: typeof req.responseFormat === "string"
          ? req.responseFormat
          : "mp3",
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      throw new Error(`OpenAI TTS error ${response.status}: ${err}`)
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    const base64 = buffer.toString("base64")

    yield {
      index: 0,
      audioBase64: base64,
      durationMs: 0, // OpenAI 不返回时长，前端解码后计算
      textFragment: req.text,
    }
  }

  async buildPhonemeTimeline(_text: string, _voice: VoiceProfile) {
    // OpenAI TTS 不返回 phoneme 数据，返回 estimated 标记
    return { phonemes: [], totalDurationMs: 0, source: "estimated" as const }
  }

  async listVoices(): Promise<VoiceProfile[]> {
    // OpenAI 预定义语音列表
    return [
      { id: "alloy" as import("@ema-agent/core-types").VoiceId, name: "Alloy", engine: "openai", voiceModel: "alloy", pitch: 1.0, speed: 1.0, defaultEmotion: "neutral", audioFormat: { codec: "mp3", sampleRate: 24000, channels: 1 }, preset: true },
      { id: "echo" as import("@ema-agent/core-types").VoiceId, name: "Echo", engine: "openai", voiceModel: "echo", pitch: 1.0, speed: 1.0, defaultEmotion: "neutral", audioFormat: { codec: "mp3", sampleRate: 24000, channels: 1 }, preset: true },
      { id: "fable" as import("@ema-agent/core-types").VoiceId, name: "Fable", engine: "openai", voiceModel: "fable", pitch: 1.0, speed: 1.0, defaultEmotion: "neutral", audioFormat: { codec: "mp3", sampleRate: 24000, channels: 1 }, preset: true },
      { id: "onyx" as import("@ema-agent/core-types").VoiceId, name: "Onyx", engine: "openai", voiceModel: "onyx", pitch: 1.0, speed: 1.0, defaultEmotion: "neutral", audioFormat: { codec: "mp3", sampleRate: 24000, channels: 1 }, preset: true },
      { id: "nova" as import("@ema-agent/core-types").VoiceId, name: "Nova", engine: "openai", voiceModel: "nova", pitch: 1.0, speed: 1.0, defaultEmotion: "neutral", audioFormat: { codec: "mp3", sampleRate: 24000, channels: 1 }, preset: true },
      { id: "shimmer" as import("@ema-agent/core-types").VoiceId, name: "Shimmer", engine: "openai", voiceModel: "shimmer", pitch: 1.0, speed: 1.0, defaultEmotion: "neutral", audioFormat: { codec: "mp3", sampleRate: 24000, channels: 1 }, preset: true },
    ]
  }
}
