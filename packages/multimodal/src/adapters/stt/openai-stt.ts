/**
 * STT Adapter 实现 — OpenAI Whisper API。
 *
 * POST https://api.openai.com/v1/audio/transcriptions
 */

import type { SttRequest } from "@ema-agent/core-types"
import type { SttAdapter } from "../../multimodal-facade.js"

export class OpenAISstAdapter implements SttAdapter {
  readonly engine = "openai"

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {}

  async *transcribe(req: SttRequest): AsyncIterable<{
    type: "interim" | "final" | "vad"
    text?: string
    confidence?: number
    detectedLanguage?: string
    audioDurationMs?: number
  }> {
    const form = new FormData()
    form.append("model", String(req.modelId))
    form.append("language", req.languageHint ?? "zh")

    // 将 base64 音频转回 Blob
    const audioBytes = Buffer.from(req.audioBase64, "base64")
    form.append("file", new Blob([audioBytes], { type: "audio/wav" }), "audio.wav")
    form.append("response_format", "verbose_json")

    const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.apiKey}` },
      body: form,
    })

    if (!response.ok) {
      throw new Error(`OpenAI STT error ${response.status}`)
    }

    const result = await response.json() as {
      text: string
      language?: string
      duration?: number
      segments?: Array<{ text: string; confidence: number }>
    }

    yield {
      type: "final",
      text: result.text,
      confidence: result.segments?.[0]?.confidence ?? 0.9,
      detectedLanguage: result.language ?? req.languageHint,
      audioDurationMs: (result.duration ?? 0) * 1000,
    }
  }
}
