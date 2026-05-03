import { createOpenAiLikeAdapter } from "./common.js"

/** OpenAI-compatible adapter，DeepSeek / OpenRouter / Ollama 先共用这套实现。 */
export function createOpenAiCompatibleAdapter() {
  return createOpenAiLikeAdapter({
    kind: "openai-compatible",
    displayName: "OpenAI Compatible",
  })
}
