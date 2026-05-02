import { createLlmAdapterSkeleton } from "./common.js"

/** Gemini adapter 骨架。 */
export function createGeminiAdapter() {
  return createLlmAdapterSkeleton({
    kind: "gemini",
    displayName: "Gemini",
  })
}
