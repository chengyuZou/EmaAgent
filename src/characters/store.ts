// 聚合角色定义与三类表现资源，并负责角色 CRUD、激活、内置种子和切换广播。

import fs from 'node:fs';
import type { Database, CharacterCardsRepo, SqliteDb } from '@ema-agent/storage';
import {
  CharacterCardsRepo as Repo,
  CharacterLive2dVariantsRepo,
  CharacterIllustrationsRepo,
  CharacterVoiceReferencesRepo,
} from '@ema-agent/storage';
import type { CharacterCard, CharacterCardInput } from './types.js';
import { CharacterCardRepository } from './repository.js';
import { EMA_CARD_ID, BUILTIN_CARDS } from './seed/index.js';
import type {
  CharacterLive2dVariant,
  CharacterLive2dVariantInput,
  CharacterLive2dVariantPatch,
  ImportCharacterLive2dInput,
} from './live2d/types.js';
import { CharacterLive2dRepository } from './live2d/repository.js';
import type {
  CharacterIllustration,
  CharacterIllustrationInput,
  CharacterIllustrationPatch,
  ImportCharacterIllustrationInput,
} from './illustration/types.js';
import { CharacterIllustrationRepository } from './illustration/repository.js';
import type {
  CharacterVoiceReference,
  CharacterVoiceReferenceInput,
  CharacterVoiceReferencePatch,
  ImportCharacterVoiceReferenceInput,
} from './voice/types.js';
import { CharacterVoiceReferenceRepository } from './voice/repository.js';
import { CharacterResourcePaths } from './resources/characterResourcePaths.js';
import {
  CharacterValidator,
  type CharacterHealth,
} from './validation/characterValidator.js';
import { assertCharacterPrompt } from './characterPrompt.js';
import { CharacterResourceLifecycle } from './resources/characterResourceLifecycle.js';
import { findLive2dPackageFilesSync } from './live2d/live2dValidator.js';
import {
  readLive2dVocabulary,
  type Live2dVocabulary,
} from './live2d/runtimeConfigVocabulary.js';

// ── 事件监听器类型 ─────────────────────────────────────────────────────────────

/**
 * 激活卡变更后触发。`previous` 只在首次激活时（如 ensureSeed 期间）为 null。
 * 订阅者重新初始化每张卡的状态：
 *
 *   emotion.updateVocabulary + emotion.reset
 *   stage.loadModel      （V1.5）
 *   tts.setReferenceAudio（V1.5）
 *
 * 这是角色领域自己的 fire-and-forget 广播。多个订阅者（emotion / stage / tts）
 * 各自独立反应；store 不等它们，也不聚合结果。
 *
 * 监听器在 activate() 内同步调用；抛错的 handler 会被记日志并吞掉，
 * 这样一个有 bug 的订阅者不会卡住激活。
 */
export type CardSwitchedListener = (
  next: CharacterCard,
  previous: CharacterCard | null,
) => void;

export type CharacterPresentationChangedListener = (card: CharacterCard) => void;

export class CharacterCardStore {
  private readonly sqlite: SqliteDb;
  private readonly repository: CharacterCardRepository;
  private readonly live2d: CharacterLive2dRepository;
  private readonly illustrations: CharacterIllustrationRepository;
  private readonly voiceReferences: CharacterVoiceReferenceRepository;
  private readonly resourcePaths: CharacterResourcePaths;
  private readonly validator: CharacterValidator;
  private readonly resourceLifecycle: CharacterResourceLifecycle;
  private readonly switchedListeners = new Set<CardSwitchedListener>();
  private readonly presentationChangedListeners =
    new Set<CharacterPresentationChangedListener>();

  constructor({
    db,
    charactersRoot,
  }: {
    db: Database;
    charactersRoot: string;
  }) {
    this.sqlite = db.sqlite;
    const repo: CharacterCardsRepo = new Repo(db.sqlite);
    this.repository = new CharacterCardRepository(repo);
    this.live2d = new CharacterLive2dRepository(
      new CharacterLive2dVariantsRepo(db.sqlite),
    );
    this.illustrations = new CharacterIllustrationRepository(
      new CharacterIllustrationsRepo(db.sqlite),
    );
    this.voiceReferences = new CharacterVoiceReferenceRepository(
      new CharacterVoiceReferencesRepo(db.sqlite),
    );
    this.resourcePaths = new CharacterResourcePaths(charactersRoot);
    this.validator = new CharacterValidator(this.resourcePaths);
    this.resourceLifecycle = new CharacterResourceLifecycle(
      id => this.get(id),
      this.live2d,
      this.illustrations,
      this.voiceReferences,
      this.resourcePaths,
      (id, input) => this.insertLive2dAndRefreshVocabulary(id, input),
      (id, resourceId) => this.deleteLive2dAndRefreshVocabulary(id, resourceId),
      id => this.emitPresentationChanged(id),
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

  onPresentationChanged(handler: CharacterPresentationChangedListener): () => void {
    this.presentationChangedListeners.add(handler);
    return () => {
      this.presentationChangedListeners.delete(handler);
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
      const cardId = seed.id;
      if (!this.repository.findById(cardId)) {
        assertCharacterPrompt(seed.card.systemPrompt, cardId);
        this.repository.insert(seed.card, { id: cardId, isBuiltin: true });
      }

      const existingLive2d = this.live2d.list(cardId);
      const live2dIds = new Set(existingLive2d.map((item) => item.id));
      for (const input of seed.live2dVariants) {
        if (!input.id) throw new Error(`builtin Live2D resource requires id: ${seed.id}`);
        if (!live2dIds.has(input.id)) {
          this.insertLive2dAndRefreshVocabulary(cardId, { ...input, id: input.id });
        }
      }

      // 旧种子行可能仍保存手写词汇；启动时以当前主用模型配置纠正一次。
      this.refreshPrimaryLive2dVocabulary(cardId);

      const existingIllustrations = this.illustrations.list(cardId);
      const illustrationIds = new Set(existingIllustrations.map(item => item.id));
      for (const input of seed.illustrations) {
        if (!input.id) throw new Error(`builtin illustration resource requires id: ${seed.id}`);
        if (!illustrationIds.has(input.id)) {
          this.illustrations.insert(cardId, input);
        }
      }

      const existingVoices = this.voiceReferences.list(cardId);
      const voiceIds = new Set(existingVoices.map((item) => item.id));
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
      const emaId = EMA_CARD_ID;
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
    const cards = this.repository.list();
    const ids = cards.map((card) => card.id);
    // 批量分组查询:N 张卡 4 次 SQL(1 卡表 + 3 资源表),不是 1 + 3N。
    const live2dByCard = this.live2d.listForCards(ids);
    const illustrationsByCard = this.illustrations.listForCards(ids);
    const voiceByCard = this.voiceReferences.listForCards(ids);
    return cards.map((card) => ({
      ...card,
      live2dVariants: live2dByCard.get(card.id) ?? [],
      illustrations: illustrationsByCard.get(card.id) ?? [],
      voiceReferences: voiceByCard.get(card.id) ?? [],
    }));
  }

  get(id: string): CharacterCard | undefined {
    const card = this.repository.findById(id);
    return card ? this.withResources(card) : undefined;
  }

  activate(id: string): string {
    const target = this.get(id);
    if (!target) throw new Error(`character card not found: ${id}`);
    assertCharacterPrompt(target.systemPrompt, id);

    const active = this.repository.findActive();
    const before = active ? this.withResources(active) : null;
    this.repository.activate(id);

    // 只有激活 id 真的变了才 emit。重新激活同一张卡是 no-op--
    // 省得订阅者跑多余的 reset 循环。
    if (!before || before.id !== target.id) {
      this.emitSwitched(target, before);
    }
    return id;
  }

  create(input: CharacterCardInput): CharacterCard {
    assertCharacterPrompt(input.systemPrompt);
    return this.withResources(this.repository.insert(input));
  }

  update(id: string, patch: Partial<CharacterCardInput>): CharacterCard {
    if (patch.systemPrompt !== undefined) {
      assertCharacterPrompt(patch.systemPrompt, id);
    }
    this.repository.update(id, patch);
    return this.get(id)!;
  }

  duplicate(id: string): CharacterCard {
    // 复制只取角色定义,不复制资源路径;用窄查询,不触发三表资源装配。
    const original = this.repository.findById(id);
    if (!original) throw new Error(`character card not found: ${id}`);
    return this.repository.insert(
      {
        name: `${original.name}(Copy)`,
        description: original.description ?? undefined,
        systemPrompt: original.systemPrompt,
      },
      { isBuiltin: false },
    );
  }

  async deleteManagedCharacter(id: string): Promise<void> {
    const card = this.get(id);
    if (!card) throw new Error(`character card not found: ${id}`);
    if (card.isBuiltin) throw new Error(`builtin character is read-only: ${id}`);
    if (card.isActive) throw new Error(`active character cannot be deleted: ${id}`);
    await fs.promises.rm(this.resourcePaths.cardRoot(id), {
      recursive: true,
      force: true,
    });
    this.repository.delete(id);
  }

  listLive2dVariants(id: string): CharacterLive2dVariant[] {
    return this.live2d.list(id);
  }

  setPrimaryLive2dVariant(id: string, resourceId: string): boolean {
    const card = this.get(id);
    if (!card) throw new Error(`character card not found: ${id}`);
    const target = card.live2dVariants.find(resource => resource.id === resourceId);
    if (!target || !target.enabled) return false;

    // 配置先读成功，再进入数据库事务；失败时当前主用模型和词汇都保持不变。
    const vocabulary = this.readVocabulary(card, target);
    const changed = this.sqlite.transaction(() => {
      const selected = this.live2d.setPrimary(id, resourceId);
      if (selected) this.writeVocabulary(id, vocabulary);
      return selected;
    })();
    if (changed) this.emitPresentationChanged(id);
    return changed;
  }

  updateLive2dVariant(
    id: string,
    resourceId: string,
    patch: CharacterLive2dVariantPatch,
  ): CharacterLive2dVariant | undefined {
    this.assertMutableResourceCard(id);
    assertResourcePatch(patch);
    const card = this.get(id);
    if (!card) throw new Error(`character card not found: ${id}`);
    const current = card.live2dVariants.find(resource => resource.id === resourceId);
    if (!current) return undefined;

    const projected = card.live2dVariants.map(resource => resource.id === resourceId
      ? {
          ...resource,
          name: patch.name ?? resource.name,
          stageScale: patch.stageScale ?? resource.stageScale,
          stageOffsetX: patch.stageOffsetX ?? resource.stageOffsetX,
          stageOffsetY: patch.stageOffsetY ?? resource.stageOffsetY,
          enabled: patch.enabled ?? resource.enabled,
        }
      : resource);
    const nextPrimary = selectPrimaryLive2d(projected);
    const vocabulary = nextPrimary ? this.readVocabulary(card, nextPrimary) : EMPTY_VOCABULARY;
    const resource = this.sqlite.transaction(() => {
      const updated = this.live2d.update(id, resourceId, patch);
      if (updated) this.writeVocabulary(id, vocabulary);
      return updated;
    })();
    if (resource) this.emitPresentationChanged(id);
    return resource;
  }

  importLive2dDirectory(
    id: string,
    input: ImportCharacterLive2dInput,
  ): Promise<CharacterLive2dVariant> {
    return this.resourceLifecycle.importLive2d(id, input);
  }

  exportLive2dDirectory(
    id: string,
    resourceId: string,
    destinationDirectory: string,
  ): Promise<string> {
    return this.resourceLifecycle.exportLive2d(id, resourceId, destinationDirectory);
  }

  deleteManagedLive2dVariant(
    id: string,
    resourceId: string,
  ): Promise<CharacterLive2dVariant | undefined> {
    return this.resourceLifecycle.deleteLive2d(id, resourceId);
  }

  listIllustrations(id: string): CharacterIllustration[] {
    return this.illustrations.list(id);
  }

  addIllustration(
    id: string,
    input: CharacterIllustrationInput,
  ): CharacterIllustration {
    const resource = this.illustrations.insert(id, input);
    this.emitPresentationChanged(id);
    return resource;
  }

  setPrimaryIllustration(id: string, resourceId: string): boolean {
    const changed = this.illustrations.setPrimary(id, resourceId);
    if (changed) this.emitPresentationChanged(id);
    return changed;
  }

  updateIllustration(
    id: string,
    resourceId: string,
    patch: CharacterIllustrationPatch,
  ): CharacterIllustration | undefined {
    this.assertMutableResourceCard(id);
    assertResourcePatch(patch);
    const resource = this.illustrations.update(id, resourceId, patch);
    if (resource) this.emitPresentationChanged(id);
    return resource;
  }

  importIllustrationFile(
    id: string,
    input: ImportCharacterIllustrationInput,
  ): Promise<CharacterIllustration> {
    return this.resourceLifecycle.importIllustration(id, input);
  }

  exportIllustrationFile(
    id: string,
    resourceId: string,
    destinationDirectory: string,
  ): Promise<string> {
    return this.resourceLifecycle.exportIllustration(id, resourceId, destinationDirectory);
  }

  deleteManagedIllustration(
    id: string,
    resourceId: string,
  ): Promise<CharacterIllustration | undefined> {
    return this.resourceLifecycle.deleteIllustration(id, resourceId);
  }

  listVoiceReferences(id: string): CharacterVoiceReference[] {
    return this.voiceReferences.list(id);
  }

  addVoiceReference(
    id: string,
    input: CharacterVoiceReferenceInput,
  ): CharacterVoiceReference {
    return this.voiceReferences.insert(id, input);
  }

  setPrimaryVoiceReference(
    id: string,
    resourceId: string,
  ): boolean {
    return this.voiceReferences.setPrimary(id, resourceId);
  }

  updateVoiceReference(
    id: string,
    resourceId: string,
    patch: CharacterVoiceReferencePatch,
  ): CharacterVoiceReference | undefined {
    this.assertMutableResourceCard(id);
    assertResourcePatch(patch);
    return this.voiceReferences.update(id, resourceId, patch);
  }

  publishVoiceReference(
    id: string,
    input: CharacterVoiceReferenceInput & { id: string },
    bytes: Uint8Array,
    extension: string,
  ): Promise<CharacterVoiceReference> {
    return this.resourceLifecycle.publishVoice(id, input, bytes, extension);
  }

  importVoiceReferenceFile(
    id: string,
    input: ImportCharacterVoiceReferenceInput,
  ): Promise<CharacterVoiceReference> {
    return this.resourceLifecycle.importVoice(id, input);
  }

  exportVoiceReferenceFile(
    id: string,
    resourceId: string,
    destinationDirectory: string,
  ): Promise<string> {
    return this.resourceLifecycle.exportVoice(id, resourceId, destinationDirectory);
  }

  deleteManagedVoiceReference(
    id: string,
    resourceId: string,
  ): Promise<CharacterVoiceReference | undefined> {
    return this.resourceLifecycle.deleteVoice(id, resourceId);
  }

  inspectHealth(id: string): Promise<CharacterHealth> {
    const card = this.get(id);
    if (!card) throw new Error(`character card not found: ${id}`);
    return this.validator.inspect(card);
  }

  resolveLive2dDirectory(id: string, resourceId: string): string {
    return this.resourcePaths.live2dDirectory(id, resourceId);
  }

  resolveIllustrationFile(
    id: string,
    resourceId: string,
  ): string {
    return this.resourcePaths.illustrationFile(id, resourceId);
  }

  resolveVoiceReferenceFile(
    id: string,
    resourceId: string,
  ): string {
    return this.resourcePaths.voiceFile(id, resourceId);
  }

  private assertMutableResourceCard(id: string): void {
    const card = this.get(id);
    if (!card) throw new Error(`character card not found: ${id}`);
    if (card.isBuiltin) throw new Error(`builtin character is read-only: ${id}`);
  }

  private withResources(card: CharacterCard): CharacterCard {
    return {
      ...card,
      live2dVariants: this.live2d.list(card.id),
      illustrations: this.illustrations.list(card.id),
      voiceReferences: this.voiceReferences.list(card.id),
    };
  }

  private insertLive2dAndRefreshVocabulary(
    id: string,
    input: CharacterLive2dVariantInput & { id: string },
  ): CharacterLive2dVariant {
    const card = this.get(id);
    if (!card) throw new Error(`character card not found: ${id}`);

    const becomesPrimary = input.enabled !== false
      && (input.isPrimary === true || !selectPrimaryLive2d(card.live2dVariants));
    const vocabulary = becomesPrimary
      ? this.readVocabulary(card, input)
      : null;

    return this.sqlite.transaction(() => {
      const inserted = this.live2d.insert(id, {
        ...input,
        isPrimary: becomesPrimary,
      });
      if (vocabulary) this.writeVocabulary(id, vocabulary);
      return inserted;
    })();
  }

  private deleteLive2dAndRefreshVocabulary(
    id: string,
    resourceId: string,
  ): CharacterLive2dVariant | undefined {
    const card = this.get(id);
    if (!card) throw new Error(`character card not found: ${id}`);
    const current = card.live2dVariants.find(resource => resource.id === resourceId);
    if (!current) return undefined;

    const nextPrimary = current.isPrimary
      ? selectPrimaryLive2d(card.live2dVariants.filter(resource => resource.id !== resourceId))
      : null;
    const vocabulary = nextPrimary ? this.readVocabulary(card, nextPrimary) : EMPTY_VOCABULARY;

    return this.sqlite.transaction(() => {
      const deleted = this.live2d.delete(id, resourceId);
      if (deleted && current.isPrimary) this.writeVocabulary(id, vocabulary);
      return deleted;
    })();
  }

  private refreshPrimaryLive2dVocabulary(id: string): void {
    const card = this.get(id);
    if (!card) throw new Error(`character card not found: ${id}`);
    const primary = selectPrimaryLive2d(card.live2dVariants);
    this.writeVocabulary(
      id,
      primary ? this.readVocabulary(card, primary) : EMPTY_VOCABULARY,
    );
  }

  private readVocabulary(
    card: CharacterCard,
    resource: Pick<CharacterLive2dVariant, 'id'>,
  ): Live2dVocabulary {
    const directory = this.resourcePaths.live2dDirectory(card.id, resource.id);
    const { runtimeConfigPath } = findLive2dPackageFilesSync(directory);
    return readLive2dVocabulary(runtimeConfigPath);
  }

  private writeVocabulary(id: string, vocabulary: Live2dVocabulary): void {
    const current = this.repository.findById(id);
    if (
      current
      && sameWords(current.emotionVocabulary, vocabulary.emotions)
      && sameWords(current.motionVocabulary, vocabulary.motions)
    ) {
      return;
    }
    this.repository.updateLive2dVocabulary(id, vocabulary.emotions, vocabulary.motions);
  }

  private emitPresentationChanged(id: string): void {
    const card = this.get(id);
    if (!card) return;
    for (const listener of this.presentationChangedListeners) {
      try {
        listener(card);
      } catch (error) {
        console.error('[character-card] presentation listener threw:', error);
      }
    }
  }

}

const EMPTY_VOCABULARY: Live2dVocabulary = { emotions: [], motions: [] };

function selectPrimaryLive2d(
  resources: readonly CharacterLive2dVariant[],
): CharacterLive2dVariant | undefined {
  const enabled = resources.filter(resource => resource.enabled);
  return enabled.find(resource => resource.isPrimary)
    ?? enabled.sort((left, right) => left.createdAt - right.createdAt
      || String(left.id).localeCompare(String(right.id)))[0];
}

function sameWords(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertResourcePatch(
  patch: {
    name?: string;
    stageScale?: number;
    stageOffsetX?: number;
    stageOffsetY?: number;
    enabled?: boolean;
  },
): void {
  if (
    patch.name === undefined
    && patch.stageScale === undefined
    && patch.stageOffsetX === undefined
    && patch.stageOffsetY === undefined
    && patch.enabled === undefined
  ) {
    throw new Error('character resource patch is empty');
  }
  if (patch.name !== undefined && patch.name.trim().length === 0) {
    throw new Error('character resource name is empty');
  }
  if (patch.stageScale !== undefined && (
    !Number.isFinite(patch.stageScale)
    || patch.stageScale < 0.1
    || patch.stageScale > 5
  )) {
    throw new Error('character resource stage scale is invalid');
  }
  for (const offset of [patch.stageOffsetX, patch.stageOffsetY]) {
    if (offset !== undefined && (
      !Number.isFinite(offset)
      || offset < -1
      || offset > 1
    )) {
      throw new Error('character resource stage offset is invalid');
    }
  }
}
