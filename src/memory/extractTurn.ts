import type { MemoryExtractionJobKind } from '@ema-agent/storage';
import {
  runTurnExtraction,
  type CompleteMemoryLlm,
  type CompletedTurnMemoryInput,
  type MemoryExtractionOutput,
} from './common/extraction.js';
import { serializeRelationshipTurn } from './relationship/extraction.js';
import { loadTemplate, type ExtractionTemplates } from './templates/loader.js';
import { serializeWorkTurn } from './work/extraction.js';

export interface CreateExtractTurnDeps {
  readonly loadCompletedTurn: (turnId: string) => Promise<CompletedTurnMemoryInput>;
  readonly complete: CompleteMemoryLlm;
  readonly templates?: Partial<ExtractionTemplates>;
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
      const [system, instructions] = await Promise.all([
        deps.templates?.workSystem ?? loadTemplate('workSystem'),
        deps.templates?.workInput ?? loadTemplate('workInput'),
      ]);
      const content = await runTurnExtraction(
        system,
        instructions,
        serializeWorkTurn({ messages: turn.messages }),
        deps.complete,
        signal,
      );
      return content ? { sessionId: turn.sessionId, content } : undefined;
    }

    if (!turn.characterName) return undefined;
    const [system, instructions] = await Promise.all([
      deps.templates?.relationshipSystem ?? loadTemplate('relationshipSystem'),
      deps.templates?.relationshipInput ?? loadTemplate('relationshipInput'),
    ]);
    const content = await runTurnExtraction(
      system,
      instructions,
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
