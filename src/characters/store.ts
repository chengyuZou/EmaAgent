// 聚合角色定义与三类表现资源，并负责角色 CRUD、激活、内置种子和切换广播。

import type { Database, CharacterCardsRepo } from '@ema-agent/storage';
import {
  CharacterCardsRepo as Repo,
  CharacterLive2dVariantsRepo,
  CharacterPortraitsRepo,
  CharacterVoiceReferencesRepo,
} from '@ema-agent/storage';
import type {
  CharacterCardId,
  CharacterLive2dId,
  CharacterPortraitId,
  CharacterVoiceReferenceId,
} from '@ema-agent/ids';
import { asCharacterCardId } from '@ema-agent/ids';
import type { CharacterCard, CharacterCardInput } from './types.js';
import { CharacterCardRepository } from './repository.js';
import { EMA_CARD_ID, BUILTIN_CARDS } from './seed/index.js';
import type {
  CharacterLive2dVariant,
  CharacterLive2dVariantInput,
} from './live2d/types.js';
import { CharacterLive2dRepository } from './live2d/repository.js';
import type { CharacterPortrait, CharacterPortraitInput } from './portraits/types.js';
import { CharacterPortraitRepository } from './portraits/repository.js';
import type {
  CharacterVoiceReference,
  CharacterVoiceReferenceInput,
} from './voiceReferences/types.js';
import { CharacterVoiceReferenceRepository } from './voiceReferences/repository.js';

// ── 事件监听器类型 ─────────────────────────────────────────────────────────────

/**
 * 激活卡变更后触发。`previous` 只在首次激活时（如 ensureSeed 期间）为 null。
 * 订阅者重新初始化每张卡的状态：
 *
 *   emotion.updateVocabulary + emotion.reset
 *   stage.loadModel      （V1.5）
 *   tts.setReferenceAudio（V1.5）
 *
 * 不是 HookBus--这是 fire-and-forget 广播。多个订阅者（emotion / stage / tts）
 * 各自独立反应；store 不等它们，也不聚合结果。
 *
 * 监听器在 activate() 内同步调用；抛错的 handler 会被记日志并吞掉，
 * 这样一个有 bug 的订阅者不会卡住激活。
 */
export type CardSwitchedListener = (
  next: CharacterCard,
  previous: CharacterCard | null,
) => void;

export class CharacterCardStore {
  private readonly repository: CharacterCardRepository;
  private readonly live2d: CharacterLive2dRepository;
  private readonly portraits: CharacterPortraitRepository;
  private readonly voiceReferences: CharacterVoiceReferenceRepository;
  private readonly switchedListeners = new Set<CardSwitchedListener>();

  constructor({ db }: { db: Database }) {
    const repo: CharacterCardsRepo = new Repo(db.sqlite);
    this.repository = new CharacterCardRepository(repo);
    this.live2d = new CharacterLive2dRepository(
      new CharacterLive2dVariantsRepo(db.sqlite),
    );
    this.portraits = new CharacterPortraitRepository(
      new CharacterPortraitsRepo(db.sqlite),
    );
    this.voiceReferences = new CharacterVoiceReferenceRepository(
      new CharacterVoiceReferencesRepo(db.sqlite),
    );
  }

  // ── 事件订阅 ──────────────────────────────────────────────────────────────────

  /**
   * 订阅激活卡变更。返回反注册函数，便于确定性清理（测试、模式切换等）。
   */
  onSwitched(handler: CardSwitchedListener): () => void {
    this.switchedListeners.add(handler);
    return () => {
      this.switchedListeners.delete(handler);
    };
  }

  private emitSwitched(next: CharacterCard, previous: CharacterCard | null): void {
    for (const fn of this.switchedListeners) {
      try { fn(next, previous); }
      catch (err) {
        console.error('[character-card] switched listener threw:', err);
      }
    }
  }

  ensureSeed(): void {
    // 种子所有内置卡（不只 Ema）。每张缺失则插入。
    // 新增内置角色只需在 seed/index.ts 的 BUILTIN_CARDS 里 push--这里不用改接线。
    for (const seed of BUILTIN_CARDS) {
      const cardId = asCharacterCardId(seed.id);
      if (!this.repository.findById(cardId)) {
        this.repository.insert(seed.card, { id: cardId, isBuiltin: true });
      }

      const live2dIds = new Set(this.live2d.list(cardId).map((item) => item.id));
      for (const input of seed.live2dVariants) {
        if (!input.id) throw new Error(`builtin Live2D resource requires id: ${seed.id}`);
        if (!live2dIds.has(input.id)) {
          this.live2d.insert(cardId, input);
        }
      }

      const portraitIds = new Set(this.portraits.list(cardId).map((item) => item.id));
      for (const input of seed.portraits) {
        if (!input.id) throw new Error(`builtin portrait resource requires id: ${seed.id}`);
        if (!portraitIds.has(input.id)) {
          this.portraits.insert(cardId, input);
        }
      }

      const voiceIds = new Set(
        this.voiceReferences.list(cardId).map((item) => item.id),
      );
      for (const input of seed.voiceReferences) {
        if (!input.id) throw new Error(`builtin voice resource requires id: ${seed.id}`);
        if (!voiceIds.has(input.id)) {
          this.voiceReferences.insert(cardId, input);
        }
      }
    }

    // 没有激活卡时激活 Ema。
    const before = this.repository.findActive();
    if (!before) {
      const emaId = asCharacterCardId(EMA_CARD_ID);
      this.repository.activate(emaId);
      const after = this.get(emaId);
      if (after) this.emitSwitched(after, null);
    }
  }

  current(): CharacterCard {
    const card = this.repository.findActive();
    if (!card) throw new Error('no active character card - call ensureSeed() at startup');
    return this.withResources(card);
  }

  list(): CharacterCard[] {
    return this.repository.list().map((card) => this.withResources(card));
  }

  get(id: CharacterCardId): CharacterCard | undefined {
    const card = this.repository.findById(id);
    return card ? this.withResources(card) : undefined;
  }

  activate(id: CharacterCardId): CharacterCardId {
    const target = this.get(id);
    if (!target) throw new Error(`character card not found: ${id}`);

    const active = this.repository.findActive();
    const before = active ? this.withResources(active) : null;
    this.repository.activate(id);
    const after = this.current();

    // 只有激活 id 真的变了才 emit。重新激活同一张卡是 no-op--
    // 省得订阅者跑多余的 reset 循环。
    if (!before || before.id !== after.id) {
      this.emitSwitched(after, before);
    }
    return id;
  }

  create(input: CharacterCardInput): CharacterCard {
    return this.withResources(this.repository.insert(input));
  }

  update(id: CharacterCardId, patch: Partial<CharacterCardInput>): CharacterCard {
    this.repository.update(id, patch);
    return this.get(id)!;
  }

  duplicate(id: CharacterCardId): CharacterCard {
    const original = this.get(id);
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
      },
      { isBuiltin: false },
    );
  }

  delete(id: CharacterCardId): void {
    this.repository.delete(id);
  }

  listLive2dVariants(id: CharacterCardId): CharacterLive2dVariant[] {
    return this.live2d.list(id);
  }

  addLive2dVariant(
    id: CharacterCardId,
    input: CharacterLive2dVariantInput,
  ): CharacterLive2dVariant {
    return this.live2d.insert(id, input);
  }

  setPrimaryLive2dVariant(id: CharacterCardId, resourceId: CharacterLive2dId): boolean {
    return this.live2d.setPrimary(id, resourceId);
  }

  deleteLive2dVariant(
    id: CharacterCardId,
    resourceId: CharacterLive2dId,
  ): CharacterLive2dVariant | undefined {
    return this.live2d.delete(id, resourceId);
  }

  listPortraits(id: CharacterCardId): CharacterPortrait[] {
    return this.portraits.list(id);
  }

  addPortrait(id: CharacterCardId, input: CharacterPortraitInput): CharacterPortrait {
    return this.portraits.insert(id, input);
  }

  setPrimaryPortrait(id: CharacterCardId, resourceId: CharacterPortraitId): boolean {
    return this.portraits.setPrimary(id, resourceId);
  }

  deletePortrait(
    id: CharacterCardId,
    resourceId: CharacterPortraitId,
  ): CharacterPortrait | undefined {
    return this.portraits.delete(id, resourceId);
  }

  listVoiceReferences(id: CharacterCardId): CharacterVoiceReference[] {
    return this.voiceReferences.list(id);
  }

  addVoiceReference(
    id: CharacterCardId,
    input: CharacterVoiceReferenceInput,
  ): CharacterVoiceReference {
    return this.voiceReferences.insert(id, input);
  }

  setPrimaryVoiceReference(
    id: CharacterCardId,
    resourceId: CharacterVoiceReferenceId,
  ): boolean {
    return this.voiceReferences.setPrimary(id, resourceId);
  }

  deleteVoiceReference(
    id: CharacterCardId,
    resourceId: CharacterVoiceReferenceId,
  ): CharacterVoiceReference | undefined {
    return this.voiceReferences.delete(id, resourceId);
  }

  private withResources(card: CharacterCard): CharacterCard {
    return {
      ...card,
      live2dVariants: this.live2d.list(card.id),
      portraits: this.portraits.list(card.id),
      voiceReferences: this.voiceReferences.list(card.id),
    };
  }
}
