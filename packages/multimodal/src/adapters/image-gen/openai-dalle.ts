/**
 * ImageGen Adapter 实现 — OpenAI DALL-E API。
 *
 * POST https://api.openai.com/v1/images/generations
 */

import type { GeneratedImage, ImageGenRequest } from "@ema-agent/core-types"
import type { ImageGenAdapter } from "../../multimodal-facade.js"

export class OpenAIDalleAdapter implements ImageGenAdapter {
  readonly engine = "openai"

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {}

  async *generate(req: ImageGenRequest): AsyncIterable<{
    type: "progress" | "complete"
    progress?: number
    stage?: string
    images?: GeneratedImage[]
    revisedPrompt?: string
  }> {
    yield { type: "progress", progress: 0, stage: "submitting" }

    const response = await fetch(`${this.baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: req.modelId,
        prompt: req.prompt,
        n: req.n ?? 1,
        size: req.size ?? "1024x1024",
        quality: req.quality ?? "standard",
      }),
    })

    if (!response.ok) {
      throw new Error(`DALL-E error ${response.status}`)
    }

    yield { type: "progress", progress: 50, stage: "generating" }

    const result = await response.json() as {
      data: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>
    }

    const images: GeneratedImage[] = result.data.map((img) => ({
      url: img.url ?? "",
      base64: img.b64_json,
      mimeType: "image/png",
      width: 1024,
      height: 1024,
      revisedPrompt: img.revised_prompt,
    }))

    yield { type: "complete", images, revisedPrompt: result.data[0]?.revised_prompt }
  }
}
