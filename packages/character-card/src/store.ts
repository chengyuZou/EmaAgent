import type { Database, CharacterCardsRepo } from '@ema-agent/storage';
import { CharacterCardsRepo as Repo } from '@ema-agent/storage';
import type { CharacterCardId } from '@ema-agent/contracts';
import { asCharacterCardId } from '@ema-agent/contracts';
import type { HookBus } from '@ema-agent/hook';
import type { CharacterCard, CharacterCardInput } from './types.js';
import { CharacterCardRepository } from './repository.js';
import { buildSystemBlock } from './system-block.js';
import { EMA_CARD_ID, EMA_CARD_INPUT } from './seed.js';

export class CharacterCardStore {
  private readonly repository: CharacterCardRepository;
  private bus?: HookBus;

  constructor({ db }: { db: Database }) {
    const repo: CharacterCardsRepo = new Repo(db.sqlite);
    this.repository = new CharacterCardRepository(repo);
  }

  ensureSeed(): void {
    const emaId = asCharacterCardId(EMA_CARD_ID);
    if (!this.repository.findById(emaId)) {
      this.repository.insert(EMA_CARD_INPUT, { id: EMA_CARD_ID, isBuiltin: true });
    }
    if (!this.repository.findActive()) {
      this.repository.activate(emaId);
    }
  }

  current(): CharacterCard {
    const card = this.repository.findActive();
    if (!card) throw new Error('no active character card — call ensureSeed() at startup');
    return card;
  }

  list(): CharacterCard[] {
    return this.repository.list();
  }

  get(id: CharacterCardId): CharacterCard | undefined {
    return this.repository.findById(id);
  }

  async activate(id: CharacterCardId): Promise<void> {
    const previous = this.current();
    this.repository.activate(id);
    const next = this.repository.findById(id);
    if (!next) throw new Error(`character card not found: ${id}`);

    await this.bus?.trigger('onCharacterCardSwitch', {
      turnId: '' as never,
      sessionId: '' as never,
      meta: {},
      payload: { previousCardId: previous.id, nextCardId: next.id },
    });
  }

  create(input: CharacterCardInput): CharacterCard {
    return this.repository.insert(input);
  }

  update(id: CharacterCardId, patch: Partial<CharacterCardInput>): CharacterCard {
    this.repository.update(id, patch);
    return this.repository.findById(id)!;
  }

  duplicate(id: CharacterCardId): CharacterCard {
    const original = this.repository.findById(id);
    if (!original) throw new Error(`character card not found: ${id}`);
    return this.repository.insert(
      {
        name: `${original.name}(Copy)`,
        version: original.version,
        description: original.description ?? undefined,
        systemPrompt: original.systemPrompt,
        speechPatterns: original.speechPatterns,
        forbiddenTopics: original.forbiddenTopics,
        emotionVocabulary: original.emotionVocabulary,
        motionVocabulary: original.motionVocabulary,
        live2dModelId: original.live2dModelId ?? undefined,
      },
      { isBuiltin: false },
    );
  }

  delete(id: CharacterCardId): void {
    this.repository.delete(id);
  }

  importFromFile(_buf: Uint8Array): Promise<CharacterCard> {
    return Promise.reject(new Error('importFromFile not implemented in V1'));
  }

  exportToFile(_id: CharacterCardId): Promise<Uint8Array> {
    return Promise.reject(new Error('exportToFile not implemented in V1'));
  }

  buildSystemBlock(): string {
    return buildSystemBlock(this.current());
  }

  registerHooks(bus: HookBus): void {
    this.bus = bus;

    bus.register(
      'beforeLlm',
      (ctx) => {
        const block = buildSystemBlock(this.current());
        const existing = ctx.payload.systemPrompt;
        return {
          kind: 'replace',
          payload: {
            ...ctx.payload,
            systemPrompt: existing ? `${block}\n\n${existing}` : block,
          },
        };
      },
      { name: 'character-card/inject-system-block', priority: 10 },
    );
  }
}
