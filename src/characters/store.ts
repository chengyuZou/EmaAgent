import { CharacterStickerRepo } from '@ema-agent/storage';
import { CharacterStickerStore } from './stickers/store.js';
import fs from 'node:fs';
import {
  CharacterRepo,
  CharacterLive2dModelRepo,
  CharacterIllustrationRepo,
  CharacterVoiceSampleRepo,
  type CharacterRow,
  type CharacterDeleteResult,
  type Database,
} from '@ema-agent/storage';
import type {
  Character,
  CharacterCard,
  CharacterInput,
  CharacterPatch,
  CharacterSummary,
  CharacterStagePresentation,
} from './types.js';
import { CharacterLive2dStore } from './live2d/store.js';
import { CharacterIllustrationStore } from './illustration/store.js';
import { CharacterVoiceSampleStore } from './voice/store.js';
import { CharacterMutations } from './resources/characterMutations.js';
import { CharacterResourcePaths, physicalName } from './resources/resourcePaths.js';
import { removeDirectoryIfPresent } from './resources/resourceFiles.js';
import { assertPersonaPrompt } from './characterPrompt.js';
import { BUILTIN_CHARACTERS, EMA_CHARACTER_NAME } from './seed/index.js';
import { live2dDirectoryByteSizeSync } from './live2d/live2dFiles.js';
import {
  CharacterDirectoryConflictError,
  CharacterInputInvalidError,
  CharacterNotFoundError,
  CharacterStateInvalidError,
} from './errors.js';

export type CharacterSwitchedListener = (
  next: Character,
  presentation: CharacterStagePresentation,
) => void;

export type CharacterPresentationChangedListener = (
  character: Character,
  presentation: CharacterStagePresentation,
) => void;

export type CharacterResourcesChangedListener = (character: Character) => void;

export class CharacterStore {
  private readonly repository: CharacterRepo;
  readonly stickers: CharacterStickerStore;
  readonly live2dModels: CharacterLive2dStore;
  readonly illustrations: CharacterIllustrationStore;
  readonly voiceSamples: CharacterVoiceSampleStore;
  private readonly paths: CharacterResourcePaths;
  private readonly mutations: CharacterMutations;
  private readonly switchedListeners = new Set<CharacterSwitchedListener>();
  private readonly presentationChangedListeners = new Set<CharacterPresentationChangedListener>();
  private readonly resourcesChangedListeners = new Set<CharacterResourcesChangedListener>();

  constructor(db: Database, charactersRoot: string) {
    fs.mkdirSync(charactersRoot, { recursive: true });
    this.paths = new CharacterResourcePaths(charactersRoot);
    this.repository = new CharacterRepo(db.sqlite);
    this.mutations = new CharacterMutations(
      this.paths,
      name => this.getRequiredCharacterOnly(name),
      name => this.resourcesChanged(name),
      name => this.emitPresentationChanged(name),
    );
    this.stickers = new CharacterStickerStore(new CharacterStickerRepo(db.sqlite), this.mutations);
    this.live2dModels = new CharacterLive2dStore(new CharacterLive2dModelRepo(db.sqlite), this.mutations);
    this.illustrations = new CharacterIllustrationStore(new CharacterIllustrationRepo(db.sqlite), this.mutations);
    this.voiceSamples = new CharacterVoiceSampleStore(new CharacterVoiceSampleRepo(db.sqlite), this.mutations);
    // 每个资源根目录只创建一个 Store. 重启后清理无法继续提交的暂存导入.
    fs.rmSync(this.paths.stagingRoot(), { recursive: true, force: true });
    this.live2dModels.backfillByteSizes(this.repository.list().map(card => card.name));
  }

  private findCard(name: string): CharacterCard | undefined {
    const row = this.repository.findByName(name);
    return row ? fromRow(row) : undefined;
  }

  private findActiveCard(): CharacterCard | undefined {
    const row = this.repository.findActive();
    return row ? fromRow(row) : undefined;
  }

  inspectStagePresentation(characterName: string): CharacterStagePresentation {
    const card = this.getRequiredCharacterOnly(characterName);
    if (card.stageKind === 'live2d') return this.live2dModels.presentation(characterName);
    if (card.stageKind === 'illustration') return this.illustrations.presentation(characterName);
    return { status: 'blank', characterName };
  }

  onSwitched(handler: CharacterSwitchedListener): () => void {
    this.switchedListeners.add(handler);
    return () => this.switchedListeners.delete(handler);
  }

  onPresentationChanged(handler: CharacterPresentationChangedListener): () => void {
    this.presentationChangedListeners.add(handler);
    return () => this.presentationChangedListeners.delete(handler);
  }

  onResourcesChanged(handler: CharacterResourcesChangedListener): () => void {
    this.resourcesChangedListeners.add(handler);
    return () => this.resourcesChangedListeners.delete(handler);
  }

  initializeBuiltinCharacters(): void {
    for (const seed of BUILTIN_CHARACTERS) {
      const input = normalizeCharacterInput(seed.card);
      assertPersonaPrompt(input.personaPrompt, input.name);
      if (!this.findCard(input.name)) {
        this.repository.insert({ ...input, stageKind: seed.stageKind, createdAt: Date.now(), updatedAt: Date.now() });
      }
      for (const model of seed.live2dModels) {
        if (!this.live2dModels.list(input.name).some(item => item.name === model.name)) {
          const directory = this.paths.live2dModelDirectory(input.name, model.name);
          const stat = fs.statSync(directory, { throwIfNoEntry: false });
          this.live2dModels.insert(input.name, {
            ...model,
            byteSize: stat?.isDirectory() ? live2dDirectoryByteSizeSync(directory) : null,
          });
        }
      }
      for (const illustration of seed.illustrations) {
        if (!this.illustrations.list(input.name).some(item => item.name === illustration.name)) {
          this.illustrations.insert(input.name, illustration);
        }
      }
      for (const sample of seed.voiceSamples) {
        if (!this.voiceSamples.list(input.name).some(item => item.name === sample.name)) {
          this.voiceSamples.insert(input.name, sample);
        }
      }
    }
    if (!this.findActiveCard()) {
      this.repository.activate(EMA_CHARACTER_NAME, Date.now());
      const active = this.get(EMA_CHARACTER_NAME);
      if (active) this.emitSwitched(active);
    }
  }

  current(): Character {
    const character = this.findActiveCard();
    if (!character) throw new CharacterStateInvalidError('active_character_missing');
    return this.withResources(character);
  }

  list(): Character[] {
    const characters = this.repository.list().map(fromRow);
    const names = characters.map(character => character.name);
    const live2d = this.live2dModels.listForCharacters(names);
    const illustrations = this.illustrations.listForCharacters(names);
    const voices = this.voiceSamples.listForCharacters(names);
    const stickers = this.stickers.listForCharacters(names);
    return characters.map(character => ({
      ...character,
      stickers: stickers.get(character.name) ?? [],
      stickerPromptLength: this.stickers.prompt(character.name, stickers.get(character.name) ?? []).length,
      live2dModels: live2d.get(character.name) ?? [],
      illustrations: illustrations.get(character.name) ?? [],
      voiceSamples: voices.get(character.name) ?? [],
    }));
  }

  listSummaries(): CharacterSummary[] {
    return this.repository.listSummaries().map(row => ({
      name: row.name,
      displayName: row.display_name,
      description: row.description,
      stageKind: row.stage_kind,
      isActive: row.is_active === 1,
      updatedAt: row.updated_at,
      live2dCount: row.live2d_count,
      illustrationCount: row.illustration_count,
      voiceSampleCount: row.voice_sample_count,
      coverResourceName: row.cover_resource_name,
    }));
  }

  get(name: string): Character | undefined {
    const character = this.findCard(name);
    return character ? this.withResources(character) : undefined;
  }

  create(input: CharacterInput): Character {
    const normalized = normalizeCharacterInput(input);
    assertPersonaPrompt(normalized.personaPrompt, normalized.name);
    if (normalized.name.toLowerCase() === '.staging') {
      throw new CharacterDirectoryConflictError(normalized.name);
    }
    const directory = this.paths.characterDirectory(normalized.name);
    if (fs.existsSync(directory) || this.findCard(normalized.name)) {
      throw new CharacterDirectoryConflictError(normalized.name);
    }
    // 先占用稳定目录名, SQL 创建失败时撤销目录, 避免残留目录阻止再次创建同名角色.
    fs.mkdirSync(directory, { recursive: false });
    try {
      const now = Date.now();
      this.repository.insert({ ...normalized, createdAt: now, updatedAt: now });
      return this.getRequired(normalized.name);
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  update(name: string, patch: CharacterPatch): Promise<Character> {
    return this.mutations.run(name, () => {
      const current = this.getRequired(name);
      if (Object.values(patch).every(value => value === undefined)) {
        throw new CharacterInputInvalidError('character_patch_empty', name);
      }
      const normalized: CharacterPatch = {
        ...(patch.displayName !== undefined ? { displayName: patch.displayName?.trim() || null } : {}),
        ...(patch.description !== undefined ? { description: patch.description?.trim() || null } : {}),
        ...(patch.personaPrompt !== undefined ? { personaPrompt: patch.personaPrompt.trim() } : {}),
        ...(patch.stageKind !== undefined ? { stageKind: patch.stageKind } : {}),
      };
      if (normalized.personaPrompt !== undefined) {
        assertPersonaPrompt(normalized.personaPrompt, name);
      }
      this.repository.update(name, { ...normalized, updatedAt: Date.now() });
      const updated = this.get(name) ?? current;
      if (patch.stageKind !== undefined) this.emitPresentationChanged(name);
      return updated;
    });
  }

  activate(name: string): string {
    const target = this.getRequired(name);
    assertPersonaPrompt(target.personaPrompt, name);
    const previous = this.findActiveCard();
    if (!this.repository.activate(name, Date.now())) {
      throw new CharacterNotFoundError(name);
    }
    const next = this.getRequired(name);
    if (!previous || previous.name !== name) {
      this.emitSwitched(next);
    }
    return name;
  }

  deleteCharacter(name: string, replacementName?: string): Promise<CharacterDeleteResult> {
    return this.mutations.run(name, async () => {
      this.getRequiredCharacterOnly(name);
      const operationDirectory = this.mutations.createStagingOperation();
      const characterDirectory = this.paths.characterDirectory(name);
      // 目录先移入本次操作的暂存区,SQL 拒绝删除或抛错时再原位恢复.
      // 当前角色的替代激活与角色删除由 Repository 在同一事务中完成.
      const staged = await this.mutations.stageExistingPath(characterDirectory, operationDirectory);
      try {
        const result = this.repository.delete(name, replacementName);
        if (result !== 'deleted') {
          if (staged) await fs.promises.rename(staged, characterDirectory);
          return result;
        }
        if (replacementName) {
          this.emitSwitched(this.getRequired(replacementName));
        }
        return result;
      } catch (error) {
        if (staged && !fs.existsSync(characterDirectory)) {
          await fs.promises.rename(staged, characterDirectory);
        }
        throw error;
      } finally {
        await removeDirectoryIfPresent(operationDirectory);
      }
    });
  }

  resolveCharacterDirectory(characterName: string): string {
    this.getRequiredCharacterOnly(characterName);
    return this.paths.characterDirectory(characterName);
  }

  private getRequired(name: string): Character {
    const character = this.get(name);
    if (!character) throw new CharacterNotFoundError(name);
    return character;
  }

  private getRequiredCharacterOnly(name: string): CharacterCard {
    // 只需确认身份时不加载三类资源,避免一次资源操作先额外查询完整角色聚合.
    const character = this.findCard(name);
    if (!character) throw new CharacterNotFoundError(name);
    return character;
  }

  private withResources(character: CharacterCard): Character {
    const stickers = this.stickers.list(character.name);
    return {
      ...character,
      stickers,
      stickerPromptLength: this.stickers.prompt(character.name, stickers).length,
      live2dModels: this.live2dModels.list(character.name),
      illustrations: this.illustrations.list(character.name),
      voiceSamples: this.voiceSamples.list(character.name),
    };
  }

  private resourcesChanged(characterName: string): void {
    // 角色卡用 Character.updatedAt 判断服务端图片是否已经换代,所以资源文件完成后
    // 必须与资源列表通知一起推进这个时间.
    this.repository.touch(characterName, Date.now());
    const character = this.get(characterName);
    if (!character) return;
    for (const listener of this.resourcesChangedListeners) listener(character);
  }

  private emitSwitched(next: Character): void {
    const presentation = this.inspectStagePresentation(next.name);
    for (const listener of this.switchedListeners) listener(next, presentation);
  }

  private emitPresentationChanged(characterName: string): void {
    const character = this.get(characterName);
    if (!character) return;
    const presentation = this.inspectStagePresentation(characterName);
    for (const listener of this.presentationChangedListeners) listener(character, presentation);
  }
}

function fromRow(row: CharacterRow): CharacterCard {
  return {
    name: row.name,
    displayName: row.display_name,
    description: row.description,
    personaPrompt: row.persona_prompt,
    stageKind: row.stage_kind,
    isActive: row.is_active === 1,
    lastActivatedAt: row.last_activated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeCharacterInput(input: CharacterInput): CharacterInput {
  const name = physicalName(input.name.trim().normalize('NFC'));
  if (!name) throw new CharacterInputInvalidError('character_name_empty');
  return {
    name,
    displayName: input.displayName?.trim() || null,
    description: input.description?.trim() || null,
    personaPrompt: input.personaPrompt.trim(),
  };
}
