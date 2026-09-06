import type { Message } from '@ema-agent/llm';

export interface WorkExtractionInput {
  readonly messages: readonly Message[];
}

export function serializeWorkTurn(input: WorkExtractionInput): string {
  return JSON.stringify(input, null, 2);
}
