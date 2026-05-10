import { GoogleGenerativeAI } from '@google/generative-ai';
import type { Content, Part, Tool } from '@google/generative-ai';
import type { LlmAdapter } from './base.js';
import type {
  LlmRequest,
  LlmStreamChunk,
  LlmMessage,
  LlmToolDef,
  StopReason,
  ProviderConfig,
} from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case 'MAX_TOKENS': return 'max_tokens';
    case 'STOP':       return 'end_turn';
    default:           return 'end_turn';
  }
}

/**
 * Gemini differences from our normalized format:
 * 1. `system` goes to `systemInstruction`, not `contents`.
 * 2. assistant role is 'model', not 'assistant'.
 * 3. Tool call IDs don't exist — Gemini uses the function name as the identifier.
 *    We build a reverse map (callId → name) from prior assistant messages so that
 *    `role: 'tool'` entries can emit `functionResponse` with the correct name.
 * 4. Function calls are delivered complete, not streamed — no tool_use_delta.
 */
function toGeminiContents(msgs: LlmMessage[]): { system: string | undefined; contents: Content[] } {
  let system: string | undefined;
  const contents: Content[] = [];

  // Pre-build callId → name lookup from all assistant messages.
  const callIdToName = new Map<string, string>();
  for (const msg of msgs) {
    if (msg.role === 'assistant') {
      for (const tc of msg.toolCalls ?? []) {
        callIdToName.set(tc.id, tc.name);
      }
    }
  }

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i]!;

    if (msg.role === 'system') {
      system = msg.content;
      continue;
    }

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        contents.push({ role: 'user', parts: [{ text: msg.content }] });
      } else {
        // Multimodal: map LlmContentPart[] → Gemini Part[]
        // SDK types:
        //   InlineDataPart = { inlineData: { mimeType, data } }   ← base64, any format
        //   FileDataPart   = { fileData:   { mimeType, fileUri } } ← GCS / Files API URI only
        //
        // ⚠️  image_url with plain https:// is passed as fileData; Gemini will error
        //     at runtime. Callers should pre-download and use image_data instead,
        //     or use validateContentParts() to warn the user first.
        //
        // Unsupported types are silently skipped (none for Gemini — it handles
        // audio/video/PDF all via inlineData).
        const parts: Part[] = [];
        for (const part of msg.content) {
          if (part.type === 'text') {
            parts.push({ text: part.text });
            continue;
          }
          if (part.type === 'image_url') {
            // fileData requires GCS/Files API URI — pass through, let API surface the error
            parts.push({ fileData: { mimeType: 'image/jpeg', fileUri: part.url } });
            continue;
          }
          if (part.type === 'image_data' || part.type === 'audio_data' || part.type === 'file_data') {
            // All base64 content goes through inlineData — Gemini handles all mimeTypes
            parts.push({ inlineData: { mimeType: part.mimeType, data: part.data } });
            continue;
          }
          if (part.type === 'file_url') {
            parts.push({ fileData: { mimeType: part.mimeType, fileUri: part.url } });
            continue;
          }
        }
        contents.push({ role: 'user', parts });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const parts: Part[] = [];
      if (msg.content) parts.push({ text: msg.content });
      for (const tc of msg.toolCalls ?? []) {
        parts.push({ functionCall: { name: tc.name, args: tc.args as Record<string, unknown> } });
      }
      contents.push({ role: 'model', parts });
      continue;
    }

    if (msg.role === 'tool') {
      // Group consecutive tool messages into one user turn (same as Anthropic).
      const parts: Part[] = [];
      while (i < msgs.length && msgs[i]!.role === 'tool') {
        const toolMsg = msgs[i] as Extract<LlmMessage, { role: 'tool' }>;
        const name    = callIdToName.get(toolMsg.toolCallId) ?? toolMsg.toolCallId;
        let response: Record<string, unknown>;
        try {
          response = JSON.parse(toolMsg.content) as Record<string, unknown>;
        } catch {
          response = { content: toolMsg.content };
        }
        parts.push({ functionResponse: { name, response } });
        i++;
      }
      i--; // outer for-loop will increment
      contents.push({ role: 'user', parts });
    }
  }

  return { system, contents };
}

// Gemini function-calling modes (string literals to avoid importing the enum at runtime)
type GeminiFcMode = 'AUTO' | 'ANY' | 'NONE';

function toGeminiToolConfig(
  tc: LlmRequest['toolChoice'],
): { functionCallingConfig: { mode: GeminiFcMode; allowedFunctionNames?: string[] } } | undefined {
  if (tc === undefined) return undefined;
  if (tc === 'auto')    return { functionCallingConfig: { mode: 'AUTO' } };
  if (tc === 'none')    return { functionCallingConfig: { mode: 'NONE' } };
  return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [tc.name] } };
}

function toGeminiTools(tools: LlmToolDef[]): Tool[] {
  return [
    {
      functionDeclarations: tools.map(t => ({
        name:        t.name,
        description: t.description,
        // JSON Schema and Gemini's FunctionDeclarationSchema are structurally compatible
        // for the common subset we use (object + string/number/boolean properties).
        parameters: t.parameters as Parameters<typeof Object>[0],
      })),
    },
  ];
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class GeminiAdapter implements LlmAdapter {
  private readonly genAI: GoogleGenerativeAI;

  constructor(config: ProviderConfig) {
    this.genAI = new GoogleGenerativeAI(config.apiKey);
  }

  async *stream(request: LlmRequest, modelName: string): AsyncIterable<LlmStreamChunk> {
    const { system, contents } = toGeminiContents(request.messages);
    const tools      = request.toolChoice === 'none' ? undefined
                     : request.tools?.length ? toGeminiTools(request.tools) : undefined;
    const toolConfig = toGeminiToolConfig(request.toolChoice);

    const model = this.genAI.getGenerativeModel({
      model:             modelName,
      systemInstruction: system,
      tools,
      // Cast needed: Gemini SDK's ToolConfig type mirrors this shape exactly
      toolConfig:        toolConfig as Parameters<typeof this.genAI.getGenerativeModel>[0]['toolConfig'],
      generationConfig: {
        maxOutputTokens: request.maxTokens,
        temperature:     request.temperature,
      },
    });

    const result = await model.generateContentStream({ contents });
    let stopReason: StopReason = 'end_turn';

    for await (const chunk of result.stream) {
      // Respect AbortSignal — Gemini SDK doesn't natively thread it through.
      if (request.signal?.aborted) break;

      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        // Part is a discriminated union — check presence of each field.
        if ('text' in part && typeof part.text === 'string' && part.text) {
          yield { type: 'text_delta', delta: part.text };
        }
        // Gemini delivers function calls complete (not streamed), so we emit
        // tool_use_complete directly — no tool_use_delta for this provider.
        if ('functionCall' in part && part.functionCall) {
          const { name, args } = part.functionCall;
          yield { type: 'tool_use_complete', callId: name, name, args: args ?? {} };
          stopReason = 'tool_use';
        }
      }
    }

    // Usage and final stop reason come from the resolved response object.
    const finalResponse = await result.response;
    const usage         = finalResponse.usageMetadata;
    if (usage) {
      yield {
        type:         'usage',
        inputTokens:  usage.promptTokenCount     ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
      };
    }
    const finishReason = finalResponse.candidates?.[0]?.finishReason;
    if (finishReason && stopReason === 'end_turn') {
      stopReason = mapStopReason(String(finishReason));
    }

    yield { type: 'done', stopReason };
  }
}
