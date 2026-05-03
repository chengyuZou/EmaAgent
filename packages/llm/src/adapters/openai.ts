import { createOpenAiLikeAdapter } from "./common.js"

/** OpenAI adapter，协议主体复用 OpenAI-compatible 实现。 */
export function createOpenAiAdapter() {
  return createOpenAiLikeAdapter({
    kind: "openai",
    displayName: "OpenAI",
  })
}
