import type { MemoryExtractionJobKind } from '@ema-agent/storage';
import {
  runTurnExtraction,
  type CompleteMemoryLlm,
  type CompletedTurnMemoryInput,
  type MemoryExtractionOutput,
} from './common/extraction.js';
import { serializeRelationshipTurn } from './relationship/extraction.js';
import { RELATIONSHIP_EXTRACTION_INPUT, RELATIONSHIP_EXTRACTION_SYSTEM } from './relationship/prompt.js';
import { serializeWorkTurn } from './work/extraction.js';
import { WORK_EXTRACTION_INPUT, WORK_EXTRACTION_SYSTEM } from './work/prompt.js';

export interface CreateExtractTurnDeps {
  readonly loadCompletedTurn: (turnId: string) => Promise<CompletedTurnMemoryInput>;
  readonly complete: CompleteMemoryLlm;
}

export type ExtractTurn = (input: {
  readonly kind: MemoryExtractionJobKind;
  readonly turnId: string;
  readonly signal: AbortSignal;
}) => Promise<MemoryExtractionOutput | undefined>;

export function createExtractTurn(deps: CreateExtractTurnDeps): ExtractTurn {
  return async ({ kind, turnId, signal }) => {
    const turn = await deps.loadCompletedTurn(turnId);
    if (kind === 'work_extraction') {
      const content = await runTurnExtraction(
        WORK_EXTRACTION_SYSTEM,
        WORK_EXTRACTION_INPUT,
        serializeWorkTurn({ messages: turn.messages }),
        deps.complete,
        signal,
      );
      return content ? { sessionId: turn.sessionId, content } : undefined;
    }

    if (!turn.characterName) return undefined;
    const content = await runTurnExtraction(
      RELATIONSHIP_EXTRACTION_SYSTEM,
      RELATIONSHIP_EXTRACTION_INPUT,
      serializeRelationshipTurn({
        characterName: turn.characterName,
        messages: turn.messages,
      }),
      deps.complete,
      signal,
    );
    return content
      ? { sessionId: turn.sessionId, characterName: turn.characterName, content }
      : undefined;
  };
}
