/**
 * A single part of a multimodal message content array.
 *
 * Defined in `contracts` so both `session` (storage) and `llm` (adapters)
 * share the exact same type without creating a circular dependency.
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
  // ── Text ────────────────────────────────────────────────────────────────────
  | { type: 'text';       text: string }

  // ── Image ────────────────────────────────────────────────────────────────────
  | { type: 'image_url';  url: string }
  | { type: 'image_data'; data: string; mimeType: string }

  // ── Audio ────────────────────────────────────────────────────────────────────
  // OpenAI: wav / mp3 only.  Gemini: many formats.  Anthropic: not supported.
  | { type: 'audio_data'; data: string; mimeType: string }

  // ── File (primarily PDF) ─────────────────────────────────────────────────────
  // OpenAI does not support inline files — use their Files API separately.
  | { type: 'file_data';  data: string; mimeType: string; filename?: string }
  | { type: 'file_url';   url: string;  mimeType: string; filename?: string };
