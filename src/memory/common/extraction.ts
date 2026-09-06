import type { Message } from '@ema-agent/llm';

export interface CompletedTurnMemoryInput {
  readonly sessionId: string;
  readonly characterName?: string;
  readonly messages: readonly Message[];
}

export interface MemoryExtractionOutput {
  readonly sessionId: string;
  readonly characterName?: string;
  readonly content: string;
}

export type CompleteMemoryLlm = (
  messages: readonly Message[],
  signal?: AbortSignal,
) => Promise<string>;

/** Extraction 的 LLM 边界只接受 {} 或 {"content":"..."}。 */
export async function runTurnExtraction(
  systemInstructions: string,
  inputInstructions: string,
  turnText: string,
  complete: CompleteMemoryLlm,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const raw = await complete([
    { role: 'system', content: systemInstructions.trim() },
    { role: 'user', content: `${inputInstructions.trim()}\n\n${turnText}` },
  ], signal);
  const value = parseJsonObject(raw);
  const keys = Object.keys(value);
  if (keys.length === 0) return undefined;
  if (keys.length !== 1 || keys[0] !== 'content') {
    throw new Error('Memory extraction output must be {} or contain only content');
  }
  if (typeof value.content !== 'string' || value.content.trim().length === 0) {
    throw new Error('Memory extraction output must be {} or contain non-empty content');
  }
  return value.content.trim();
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const withoutFence = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed;
  let value: unknown;
  try {
    value = JSON.parse(withoutFence);
  } catch {
    throw new Error('Memory extraction output is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Memory extraction output must be a JSON object');
  }
  return value as Record<string, unknown>;
}
