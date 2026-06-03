import { randomUUID } from 'node:crypto';
import type { CharacterCardsRepo, CharacterCardRow } from '@ema-agent/storage';
import { asCharacterCardId } from '@ema-agent/contracts';
import type { CharacterCardId } from '@ema-agent/contracts';
import type { CharacterCard, CharacterCardInput, CharacterVoiceProfile } from './types.js';
import { emptyVoiceProfile } from './types.js';

// ── Row -> Domain ────────────────────────────────────────────────────────────

function parseVoiceProfile(json: string): CharacterVoiceProfile {
  if (!json) return emptyVoiceProfile();
  try {
    const parsed = JSON.parse(json) as Partial<CharacterVoiceProfile>;
    return {
      refAudios: Array.isArray(parsed.refAudios) ? parsed.refAudios : [],
      primaryId: typeof parsed.primaryId === 'string' ? parsed.primaryId : null,
    };
  } catch {
    return emptyVoiceProfile();
  }
}

function fromRow(row: CharacterCardRow): CharacterCard {
  return {
    id:               asCharacterCardId(row.id),
    name:             row.name,
    version:          row.version,
    description:      row.description,
    systemPrompt:     row.system_prompt,
    speechPatterns:   JSON.parse(row.speech_patterns_json) as string[],
    forbiddenTopics:  JSON.parse(row.forbidden_topics_json) as string[],
    emotionVocabulary: JSON.parse(row.emotion_vocab_json) as string[],
    motionVocabulary:  JSON.parse(row.motion_vocab_json) as string[],
    live2dModelId:    row.live2d_model_id,
    voiceProfile:     parseVoiceProfile(row.voice_profile_json),
    isActive:         row.is_active === 1,
    isBuiltin:        row.is_builtin === 1,
    createdAt:        row.created_at,
    updatedAt:        row.updated_at,
  };
}

// ── CharacterCardRepository ──────────────────────────────────────────────────

/** Thin domain adapter over CharacterCardsRepo — maps domain types -> DB rows. */
export class CharacterCardRepository {
  constructor(private readonly repo: CharacterCardsRepo) {}

  findById(id: CharacterCardId): CharacterCard | undefined {
    const row = this.repo.findById(id);
    return row ? fromRow(row) : undefined;
  }

  findActive(): CharacterCard | undefined {
    const row = this.repo.findActive();
    return row ? fromRow(row) : undefined;
  }

  list(): CharacterCard[] {
    return this.repo.list().map(fromRow);
  }

  insert(
    input: CharacterCardInput,
    opts: { id?: string; isBuiltin?: boolean; isActive?: boolean } = {},
  ): CharacterCard {
    const now = Date.now();
    const id = asCharacterCardId(opts.id ?? randomUUID());

    this.repo.insert({
      id,
      name:                 input.name,
      version:              input.version,
      description:          input.description,
      systemPrompt:         input.systemPrompt,
      speechPatternsJson:   JSON.stringify(input.speechPatterns ?? []),
      forbiddenTopicsJson:  JSON.stringify(input.forbiddenTopics ?? []),
      emotionVocabJson:     JSON.stringify(input.emotionVocabulary ?? []),
      motionVocabJson:      JSON.stringify(input.motionVocabulary ?? []),
      live2dModelId:        input.live2dModelId,
      voiceProfileJson:     JSON.stringify(input.voiceProfile ?? emptyVoiceProfile()),
      isActive:             opts.isActive ?? false,
      isBuiltin:            opts.isBuiltin ?? false,
      createdAt:            now,
      updatedAt:            now,
    });

    return this.findById(id)!;
  }

  update(id: CharacterCardId, patch: Partial<CharacterCardInput>): void {
    this.repo.update(id, {
      name:                 patch.name,
      version:              patch.version,
      description:          patch.description,
      systemPrompt:         patch.systemPrompt,
      speechPatternsJson:   patch.speechPatterns !== undefined
                              ? JSON.stringify(patch.speechPatterns) : undefined,
      forbiddenTopicsJson:  patch.forbiddenTopics !== undefined
                              ? JSON.stringify(patch.forbiddenTopics) : undefined,
      emotionVocabJson:     patch.emotionVocabulary !== undefined
                              ? JSON.stringify(patch.emotionVocabulary) : undefined,
      motionVocabJson:      patch.motionVocabulary !== undefined
                              ? JSON.stringify(patch.motionVocabulary) : undefined,
      live2dModelId:        patch.live2dModelId,
      voiceProfileJson:     patch.voiceProfile !== undefined
                              ? JSON.stringify(patch.voiceProfile) : undefined,
      updatedAt:            Date.now(),
    });
  }

  activate(id: CharacterCardId): void {
    this.repo.activate(id, Date.now());
  }

  /** Silently refuses to delete built-in cards (enforced by storage repo). */
  delete(id: CharacterCardId): void {
    this.repo.delete(id);
  }
}

