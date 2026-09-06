import type { Message } from '@ema-agent/llm';

export interface RelationshipExtractionInput {
  readonly characterName: string;
  readonly messages: readonly Message[];
}

export function serializeRelationshipTurn(input: RelationshipExtractionInput): string {
  return JSON.stringify(input, null, 2);
}
