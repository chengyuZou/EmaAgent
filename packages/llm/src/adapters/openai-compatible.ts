import { createLlmAdapterSkeleton } from "./common.js"

/** OpenAI compatible adapter 骨架，DeepSeek / OpenRouter / Ollama 先共用这里。 */
export function createOpenAiCompatibleAdapter() {
  return createLlmAdapterSkeleton({
    kind: "openai-compatible",
    displayName: "OpenAI Compatible",
  })
}
