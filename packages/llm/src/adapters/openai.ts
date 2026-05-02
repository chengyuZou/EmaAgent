import { createLlmAdapterSkeleton } from "./common.js"

/** OpenAI adapter 骨架。 */
export function createOpenAiAdapter() {
  return createLlmAdapterSkeleton({
    kind: "openai",
    displayName: "OpenAI",
  })
}
