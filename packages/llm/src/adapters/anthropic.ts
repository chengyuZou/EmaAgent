import { createLlmAdapterSkeleton } from "./common.js"

/** Anthropic adapter 骨架。 */
export function createAnthropicAdapter() {
  return createLlmAdapterSkeleton({
    kind: "anthropic",
    displayName: "Anthropic",
  })
}
