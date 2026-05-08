/**
 * TTS Adapter 实现 — Edge TTS（免费本地 fallback）。
 *
 * 使用 Microsoft Edge TTS 引擎，通过 HTTP API 调用。
 * 可作为离线/免费 fallback 方案。
 */

import type { TtsAudioChunk, TtsRequest, VoiceProfile } from "@ema-agent/core-types"
import type { TtsAdapter } from "../../multimodal-facade.js"

export class EdgeTtsAdapter implements TtsAdapter {
  readonly engine = "edge"

  async *synthesize(req: TtsRequest): AsyncIterable<TtsAudioChunk> {
    // Edge TTS 使用 SSML 格式
    const ssml = `
      <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">
        <voice name="zh-CN-XiaoxiaoNeural">
          <prosody rate="${req.speed ?? 1.0}" pitch="${req.pitch ? `${(req.pitch - 1) * 50}%` : "+0%"}">
            ${req.text}
          </prosody>
        </voice>
      </speak>`

    // Edge TTS API（需要本地 edge-tts 服务或直接调用）
    const response = await fetch("http://localhost:3423/tts", {
      method: "POST",
      headers: { "Content-Type": "application/ssml+xml" },
      body: ssml,
    })

    if (!response.ok) {
      throw new Error(`Edge TTS error ${response.status}`)
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    yield {
      index: 0,
      audioBase64: buffer.toString("base64"),
      durationMs: 0,
      textFragment: req.text,
    }
  }

  async buildPhonemeTimeline(text: string, _voice: VoiceProfile) {
    // Edge TTS 可通过 SSML <phoneme> 标签获取音素数据
    return { phonemes: [], totalDurationMs: this.estimateDuration(text), source: "estimated" as const }
  }

  async listVoices(): Promise<VoiceProfile[]> {
    return [
      { id: "zh-CN-XiaoxiaoNeural" as import("@ema-agent/core-types").VoiceId, name: "晓晓 (女)", engine: "edge", voiceModel: "zh-CN-XiaoxiaoNeural", pitch: 1.0, speed: 1.0, defaultEmotion: "gentle", audioFormat: { codec: "mp3", sampleRate: 24000, channels: 1 }, preset: true },
      { id: "zh-CN-YunxiNeural" as import("@ema-agent/core-types").VoiceId, name: "云希 (男)", engine: "edge", voiceModel: "zh-CN-YunxiNeural", pitch: 1.0, speed: 1.0, defaultEmotion: "neutral", audioFormat: { codec: "mp3", sampleRate: 24000, channels: 1 }, preset: true },
      { id: "ja-JP-NanamiNeural" as import("@ema-agent/core-types").VoiceId, name: "Nanami (日)", engine: "edge", voiceModel: "ja-JP-NanamiNeural", pitch: 1.0, speed: 1.0, defaultEmotion: "neutral", audioFormat: { codec: "mp3", sampleRate: 24000, channels: 1 }, preset: true },
    ]
  }

  private estimateDuration(text: string): number {
    // 粗略估算：中文每秒约 4 字
    return Math.ceil(text.length / 4) * 1000
  }
}
