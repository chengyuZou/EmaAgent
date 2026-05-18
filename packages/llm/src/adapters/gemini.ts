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
  AssistantBlock,
  UserBlock,
} from '../types.js';
import type { ToolResultBlock, MessageContentPart } from '@ema-agent/contracts';

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
 * 3. Tool results are `functionResponse` parts inside a user turn.
 * 4. Function calls are delivered complete (not streamed) — we emit synthetic
 *    tool_use_complete events with index-based callIds.
 *
 * callId fix: Gemini has no call IDs. We synthesize them as `gemini-call-{index}`
 * within each assistant turn. A lookup map built from the assistant messages lets
 * us correlate ToolResultBlock.toolUseId back to the function name.
 */
function toGeminiContents(msgs: LlmMessage[]): { system: string | undefined; contents: Content[] } {
  let system: string | undefined;
  const contents: Content[] = [];

  // Pre-build callId → name lookup from all assistant messages.
  // Synthetic IDs are "gemini-call-{turnIndex}-{blockIndex}".
  // We need to match these up to function names when we see tool_result blocks.
  const callIdToName = new Map<string, string>();
  let assistantTurnCount = 0;
  for (const msg of msgs) {
    if (msg.role === 'assistant') {
      let toolBlockIdx = 0;
      for (const block of msg.content as AssistantBlock[]) {
        if (block.type === 'tool_use') {
          // block.id was set by us during stream parsing (see stream() below)
          callIdToName.set(block.id, block.name);
          toolBlockIdx++;
        }
      }
      assistantTurnCount++;
    }
  }
  void assistantTurnCount; // used implicitly via callIdToName

  for (const msg of msgs) {
    if (msg.role === 'system') {
      system = msg.content;
      continue;
    }

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        contents.push({ role: 'user', parts: [{ text: msg.content }] });
        continue;
      }

      // UserBlock[] — split into functionResponse parts + media parts
      const parts: Part[] = [];
      for (const block of msg.content as UserBlock[]) {
        if (block.type === 'tool_result') {
          const tb = block as ToolResultBlock;
          const name = callIdToName.get(tb.toolUseId) ?? tb.toolUseId;
          let response: Record<string, unknown>;
          try {
            response = typeof tb.content === 'string'
              ? JSON.parse(tb.content) as Record<string, unknown>
              : { content: tb.content };
          } catch {
            response = { content: tb.content };
          }
          parts.push({ functionResponse: { name, response } });
          continue;
        }

        const part = block as MessageContentPart;
        switch (part.type) {
          case 'text':
            parts.push({ text: part.text });
            break;
          case 'image_url':
            // fileData requires GCS/Files API URI — pass through, let API surface the error
            parts.push({ fileData: { mimeType: 'image/jpeg', fileUri: part.url } });
            break;
          case 'image_data':
          case 'audio_data':
          case 'file_data':
            parts.push({ inlineData: { mimeType: part.mimeType, data: part.data } });
            break;
          case 'file_url':
            parts.push({ fileData: { mimeType: part.mimeType, fileUri: part.url } });
            break;
        }
      }

      if (parts.length > 0) {
        contents.push({ role: 'user', parts });
      }
      continue;
    }

    // assistant → model
    const parts: Part[] = [];
    for (const block of msg.content as AssistantBlock[]) {
      if (block.type === 'text') {
        parts.push({ text: block.text });
      } else if (block.type === 'tool_use') {
        parts.push({ functionCall: { name: block.name, args: block.args as Record<string, unknown> } });
      }
      // thinking has no Gemini equivalent; skip
    }
    contents.push({ role: 'model', parts });
  }

  return { system, contents };
}

// Gemini function-calling modes
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
        parameters:  t.parameters as Parameters<typeof Object>[0],
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
      toolConfig: toolConfig as Parameters<typeof this.genAI.getGenerativeModel>[0]['toolConfig'],
      generationConfig: {
        maxOutputTokens: request.maxTokens,
        temperature:     request.temperature,
      },
    });

    const result = await model.generateContentStream({ contents });
    let stopReason: StopReason = 'end_turn';

    // Gemini delivers all function calls at once (no partial streaming).
    // We assign a synthetic blockIndex per function call: text = 0, tools = 1000+n.
    let toolBlockIdx = 0;

    for await (const chunk of result.stream) {
      if (request.signal?.aborted) break;

      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if ('text' in part && typeof part.text === 'string' && part.text) {
          yield { type: 'text_delta', blockIndex: 0, delta: part.text };
        }
        if ('functionCall' in part && part.functionCall) {
          const { name, args } = part.functionCall;
          // Synthesize a stable callId: Gemini has no IDs, so we use name+index.
          // Two calls to the same tool get different indices → different callIds.
          const callId = `gemini-call-${toolBlockIdx}`;
          const blockIndex = 1000 + toolBlockIdx;
          toolBlockIdx++;

          // Emit synthetic start (no args delta — Gemini delivers complete)
          yield { type: 'tool_use_complete', blockIndex, callId, name, args: args ?? {} };
          stopReason = 'tool_use';
        }
      }
    }

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
