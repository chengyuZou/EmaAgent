/**
 * A single part of a multimodal message content array.
 * Used inside UserBlock for image/audio/file content sent by the user.
 *
 * Provider support matrix:
 *
 * | type       | OpenAI | Anthropic | Gemini          |
 * |------------|--------|-----------|-----------------|
 * | text       | ✅     | ✅        | ✅              |
 * | image_url  | ✅     | ✅        | ⚠️ GCS/Files only|
 * | image_data | ✅     | ✅        | ✅              |
 * | audio_data | ✅ wav/mp3 | ❌    | ✅ multi-format |
 * | file_data  | ❌     | ✅ PDF    | ✅              |
 * | file_url   | ❌     | ✅ PDF    | ⚠️ GCS/Files only|
 */
export type MessageContentPart =
  | { type: 'text';       text: string }
  | { type: 'image_url';  url: string }
  | { type: 'image_data'; data: string; mimeType: string }
  // OpenAI: wav / mp3 only.  Gemini: many formats.  Anthropic: not supported.
  | { type: 'audio_data'; data: string; mimeType: string }
  // OpenAI does not support inline files — use their Files API separately.
  | { type: 'file_data';  data: string; mimeType: string; filename?: string }
  | { type: 'file_url';   url: string;  mimeType: string; filename?: string };

// ── Content blocks (Anthropic-style normalized format) ────────────────────────

/**
 * Blocks that can appear in an assistant message, in order.
 * Interleaving is preserved: a TextBlock before a ToolUseBlock means
 * "the model said something, then called a tool" — critical for correct replay.
 *
 * - thinking: extended reasoning trace (DeepSeek-R1, Claude extended thinking).
 *   Round-tripping to Anthropic requires the original `signature` field; store it.
 * - tool_use: the model wants to call a tool. `args` is the parsed JSON object.
 */
export type AssistantBlock =
  | { type: 'text';     text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; args: unknown };

/**
 * Tool result injected back into the conversation as a user-role message.
 * Mirrors Anthropic's ToolResultBlockParam: content can be rich (image + text).
 */
export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string | MessageContentPart[];
  isError?: boolean;
}

/**
 * Blocks that can appear in a user message.
 * Covers both rich multimodal input and tool results returned from the engine.
 */
export type UserBlock = MessageContentPart | ToolResultBlock;

/**
 * Union of all storable content shapes.
 *
 * Parsing contract for `blocks_json` column:
 *   JSON.parse(blocks_json) →
 *     string            → plain text  (system, or simple user text)
 *     AssistantBlock[]  → role = 'assistant'
 *     UserBlock[]       → role = 'user' with media or tool_results
 */
export type MessageBlocks = string | AssistantBlock[] | UserBlock[];
