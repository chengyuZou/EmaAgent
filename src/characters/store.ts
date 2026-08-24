// 维护角色、Prompt Block 与三类资源的一致生命周期，是 Character 包的唯一业务入口。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SettingsStore } from '@ema-agent/settings';
import type { Database, SqliteDb } from '@ema-agent/storage';
import {
  CharacterRepo,
  CharacterLive2dModelRepo,
  CharacterIllustrationRepo,
  CharacterVoiceSampleRepo,
} from '@ema-agent/storage';
import type {
  Character,
  CharacterInput,
  CharacterPatch,
} from './types.js';
import { CharacterRepository } from './repository.js';
import { EMA_CHARACTER_ID, BUILTIN_CHARACTERS } from './seed/index.js';
import type {
  CharacterLive2dModel,
  CharacterLive2dModelInput,
  CharacterLive2dModelPatch,
  ImportCharacterLive2dModelInput,
} from './live2d/types.js';
import { CharacterLive2dModelRepository } from './live2d/repository.js';
import { findLive2dPackageFilesSync } from './live2d/live2dValidator.js';
import { readLive2dVocabulary, type Live2dVocabulary } from './live2d/live2dVocabulary.js';
import {
  deleteLive2dDirectory,
  exportLive2dZip,
  importLive2dZip,
} from './live2d/live2dFiles.js';
import type {
  CharacterIllustration,
  CharacterIllustrationPatch,
  ImportCharacterIllustrationInput,
} from './illustration/types.js';
import { CharacterIllustrationRepository } from './illustration/repository.js';
import {
  deleteIllustrationFile,
  exportIllustrationFile,
  importIllustrationFile,
} from './illustration/illustrationFiles.js';
import type {
  CharacterVoiceSample,
  CharacterVoiceSamplePatch,
  ImportCharacterVoiceSampleInput,
  PublishCharacterVoiceSampleInput,
} from './voice/types.js';
import { CharacterVoiceSampleRepository } from './voice/repository.js';
import { validateVoiceSampleFile } from './voice/voiceSampleValidator.js';
import {
  deleteVoiceFile,
  exportVoiceFile,
  importVoiceFile,
  publishVoiceFile,
} from './voice/voiceFiles.js';
import { CharacterResourcePaths, physicalName, sourceBaseName } from './resources/resourcePaths.js';
import { removeDirectoryIfPresent, removeFileIfPresent } from './resources/resourceFiles.js';
import { assertPersonaPrompt } from './characterPrompt.js';
import {
  inspectAllCharacterHealth,
  inspectCharacterHealth,
  type CharacterHealth,
  type CharacterHealthReport,
} from './characterHealth.js';
import { readCharacterSettings, type CharacterSettings } from './settings.js';
import {
  CharacterActiveDeleteError,
  CharacterDirectoryConflictError,
  CharacterInputInvalidError,
  CharacterNotFoundError,
  CharacterReadOnlyError,
  CharacterResourceMissingError,
  CharacterResourceNotFoundError,
  CharacterStateInvalidError,
  type CharacterResourceKind,
} from './errors.js';

export type CharacterSwitchedListener = (
  next: Character,
  previous: Character | null,
) => void;

export type CharacterPresentationChangedListener = (character: Character) => void;

export class CharacterStore {
  private readonly sqlite: SqliteDb;
  private readonly repository: CharacterRepository;
  private readonly live2dModels: CharacterLive2dModelRepository;
  private readonly illustrations: CharacterIllustrationRepository;
  private readonly voiceSamples: CharacterVoiceSampleRepository;
  private readonly paths: CharacterResourcePaths;
  private readonly switchedListeners = new Set<CharacterSwitchedListener>();
  private readonly presentationChangedListeners = new Set<CharacterPresentationChangedListener>();

  constructor(
    db: Database,
    charactersRoot: string,
    private readonly settingsStore: SettingsStore,
  ) {
    fs.mkdirSync(charactersRoot, { recursive: true });
    this.sqlite = db.sqlite;
    this.repository = new CharacterRepository(
      db.sqlite,
      new CharacterRepo(db.sqlite),
    );
    this.live2dModels = new CharacterLive2dModelRepository(
      new CharacterLive2dModelRepo(db.sqlite),
    );
    this.illustrations = new CharacterIllustrationRepository(
      new CharacterIllustrationRepo(db.sqlite),
    );
    this.voiceSamples = new CharacterVoiceSampleRepository(new CharacterVoiceSampleRepo(db.sqlite));
    this.paths = new CharacterResourcePaths(charactersRoot);
  }

  onSwitched(handler: CharacterSwitchedListener): () => void {
    this.switchedListeners.add(handler);
    return () => this.switchedListeners.delete(handler);
  }

  onPresentationChanged(handler: CharacterPresentationChangedListener): () => void {
    this.presentationChangedListeners.add(handler);
    return () => this.presentationChangedListeners.delete(handler);
  }

  ensureSeed(): void {
    for (const seed of BUILTIN_CHARACTERS) {
      const input = normalizeCharacterInput(seed.card);
      assertPersonaPrompt(input.personaPrompt, seed.id);
      if (!this.repository.findById(seed.id)) {
        this.repository.insert(input, seed.id, seed.id, true);
      }

      const live2dModelIds = new Set(this.live2dModels.list(seed.id).map((item) => item.id));
      for (const input of seed.live2dModels) {
        if (!input.id) {
          throw new CharacterStateInvalidError(
            'builtin_resource_id_missing',
            seed.id,
            'live2d_model',
          );
        }
        if (!live2dModelIds.has(input.id)) this.live2dModels.insert(seed.id, input);
      }
      this.refreshPrimaryLive2dVocabulary(seed.id);

      const illustrationIds = new Set(this.illustrations.list(seed.id).map((item) => item.id));
      for (const input of seed.illustrations) {
        if (!input.id) {
          throw new CharacterStateInvalidError(
            'builtin_resource_id_missing',
            seed.id,
            'illustration',
          );
        }
        if (!illustrationIds.has(input.id)) this.illustrations.insert(seed.id, input);
      }

      const voiceSampleIds = new Set(this.voiceSamples.list(seed.id).map((item) => item.id));
      for (const input of seed.voiceSamples) {
        if (!input.id) {
          throw new CharacterStateInvalidError(
            'builtin_resource_id_missing',
            seed.id,
            'voice_sample',
          );
        }
        if (!voiceSampleIds.has(input.id)) this.voiceSamples.insert(seed.id, input);
      }
    }

    if (!this.repository.findActive()) {
      this.repository.activate(EMA_CHARACTER_ID);
      const active = this.get(EMA_CHARACTER_ID);
      if (active) this.emitSwitched(active, null);
    }
  }

  current(): Character {
    const character = this.repository.findActive();
    if (!character) throw new CharacterStateInvalidError('active_character_missing');
    return this.withResources(character);
  }

  list(): Character[] {
    const characters = this.repository.list();
    const ids = characters.map((character) => character.id);
    const live2dModelsByCharacter = this.live2dModels.listForCharacters(ids);
    const illustrationsByCharacter = this.illustrations.listForCharacters(ids);
    const voiceSamplesByCharacter = this.voiceSamples.listForCharacters(ids);
    return characters.map((character) => withResources(
      character,
      live2dModelsByCharacter.get(character.id) ?? [],
      illustrationsByCharacter.get(character.id) ?? [],
      voiceSamplesByCharacter.get(character.id) ?? [],
    ));
  }

  get(id: string): Character | undefined {
    const character = this.repository.findById(id);
    return character ? this.withResources(character) : undefined;
  }

  activate(id: string): string {
    const target = this.getRequired(id);
    assertPersonaPrompt(target.personaPrompt, id);
    const active = this.repository.findActive();
    const previous = active ? this.withResources(active) : null;
    this.repository.activate(id);
    if (!previous || previous.id !== target.id) this.emitSwitched(target, previous);
    return id;
  }

  create(input: CharacterInput): Character {
    const normalized = normalizeCharacterInput(input);
    assertPersonaPrompt(normalized.personaPrompt);
    return this.createWithDirectory(normalized, physicalName(normalized.name));
  }

  update(id: string, patch: CharacterPatch): Character {
    const character = this.assertMutableCharacter(id);
    if (
      patch.name === undefined
      && patch.description === undefined
      && patch.personaPrompt === undefined
    ) {
      throw new CharacterInputInvalidError('character_patch_empty', id);
    }
    const name = patch.name === undefined ? undefined : patch.name.trim();
    if (name !== undefined && !name) {
      throw new CharacterInputInvalidError('character_name_empty', id);
    }
    const description = patch.description === undefined
      ? undefined
      : patch.description?.trim() || null;
    let personaPrompt: string | undefined;
    if (patch.personaPrompt !== undefined) {
      assertPersonaPrompt(patch.personaPrompt, id);
      personaPrompt = patch.personaPrompt.trim();
    }
    this.repository.update(id, name, description, personaPrompt);
    return this.get(id) ?? character;
  }

  duplicate(id: string): Character {
    const original = this.getRequired(id);
    const input: CharacterInput = {
      name: `${original.name}(Copy)`,
      description: original.description,
      personaPrompt: original.personaPrompt,
    };
    return this.createWithDirectory(input, physicalName(`${original.directoryName} Copy`));
  }

  async deleteManagedCharacter(id: string): Promise<void> {
    const character = this.getRequired(id);
    if (character.isBuiltin) throw new CharacterReadOnlyError(id);
    if (character.isActive) throw new CharacterActiveDeleteError(id);
    await removeDirectoryIfPresent(this.paths.characterDirectory(character.directoryName));
    this.repository.delete(id);
  }

  listLive2dModels(id: string): CharacterLive2dModel[] {
    return this.live2dModels.list(id);
  }

  setPrimaryLive2dModel(id: string, resourceId: string): boolean {
    const character = this.getRequired(id);
    const target = character.live2dModels.find((resource) => resource.id === resourceId);
    if (!target?.enabled) return false;
    const vocabulary = this.readVocabulary(character, target);
    const changed = this.sqlite.transaction(() => {
      const selected = this.live2dModels.setPrimary(id, resourceId);
      if (selected) this.writeVocabulary(id, resourceId, vocabulary);
      return selected;
    })();
    if (changed) this.emitPresentationChanged(id);
    return changed;
  }

  updateLive2dModel(
    id: string,
    resourceId: string,
    patch: CharacterLive2dModelPatch,
  ): CharacterLive2dModel | undefined {
    const character = this.assertMutableCharacter(id);
    const normalized = normalizeResourcePatch(patch);
    const current = character.live2dModels.find((resource) => resource.id === resourceId);
    if (!current) return undefined;
    const projected = character.live2dModels.map((resource) => resource.id === resourceId
      ? { ...resource, ...normalized }
      : resource);
    const nextPrimary = selectPrimaryLive2dModel(projected);
    const vocabulary = nextPrimary ? this.readVocabulary(character, nextPrimary) : EMPTY_VOCABULARY;
    const updated = this.sqlite.transaction(() => {
      const value = this.live2dModels.update(id, resourceId, normalized);
      if (value && nextPrimary) this.writeVocabulary(id, nextPrimary.id, vocabulary);
      return value;
    })();
    if (updated) this.emitPresentationChanged(id);
    return updated;
  }

  async importLive2dModel(
    id: string,
    input: ImportCharacterLive2dModelInput,
  ): Promise<CharacterLive2dModel> {
    const character = this.assertMutableCharacter(id);
    const settings = this.settings();
    const files = await importLive2dZip(
      input.sourceZipFile,
      this.paths.live2dRoot(character.directoryName),
      settings.live2d,
    );
    const destination = this.paths.live2dModelDirectory(
      character.directoryName,
      files.directoryName,
    );
    try {
      const packageFiles = findLive2dPackageFilesSync(destination);
      const vocabulary = readLive2dVocabulary(
        packageFiles.runtimeConfigPath,
        settings.live2d.maxRuntimeConfigBytes,
      );
      const resource = this.insertLive2dModel(
        id,
        {
          id: randomUUID(),
          name: files.displayName,
          directoryName: files.directoryName,
          isPrimary: input.isPrimary ?? character.live2dModels.length === 0,
          byteSize: files.byteSize,
        },
        vocabulary,
      );
      this.emitPresentationChanged(id);
      return resource;
    } catch (error) {
      await deleteLive2dDirectory(destination);
      throw error;
    }
  }

  async exportLive2dModel(id: string, resourceId: string, destinationDirectory: string): Promise<string> {
    const character = this.getRequired(id);
    const resource = requiredResource(character.live2dModels, resourceId, 'live2d_model');
    return exportLive2dZip(
      this.paths.live2dModelDirectory(character.directoryName, resource.directoryName),
      destinationDirectory,
      resource.name,
      this.settings().live2d,
    );
  }

  async deleteLive2dModel(id: string, resourceId: string): Promise<CharacterLive2dModel | undefined> {
    const character = this.assertMutableCharacter(id);
    const current = character.live2dModels.find((resource) => resource.id === resourceId);
    if (!current) return undefined;
    await deleteLive2dDirectory(
      this.paths.live2dModelDirectory(character.directoryName, current.directoryName),
    );
    const deleted = this.deleteLive2dModelRecord(character, current);
    if (deleted) this.emitPresentationChanged(id);
    return deleted;
  }

  listIllustrations(id: string): CharacterIllustration[] {
    return this.illustrations.list(id);
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
    this.assertMutableCharacter(id);
    const resource = this.illustrations.update(id, resourceId, normalizeResourcePatch(patch));
    if (resource) this.emitPresentationChanged(id);
    return resource;
  }

  async importIllustration(
    id: string,
    input: ImportCharacterIllustrationInput,
  ): Promise<CharacterIllustration> {
    const character = this.assertMutableCharacter(id);
    const files = await importIllustrationFile(
      input.sourceFile,
      this.paths.illustrationRoot(character.directoryName),
      this.settings().illustration,
    );
    const destination = this.paths.illustrationFile(character.directoryName, files.fileName);
    try {
      const resource = this.illustrations.insert(id, {
        id: randomUUID(),
        name: files.displayName,
        fileName: files.fileName,
        isPrimary: input.isPrimary ?? character.illustrations.length === 0,
        byteSize: files.byteSize,
      });
      this.emitPresentationChanged(id);
      return resource;
    } catch (error) {
      await removeFileIfPresent(destination);
      throw error;
    }
  }

  async exportIllustration(
    id: string,
    resourceId: string,
    destinationDirectory: string,
  ): Promise<string> {
    const character = this.getRequired(id);
    const resource = requiredResource(character.illustrations, resourceId, 'illustration');
    return exportIllustrationFile(
      this.paths.illustrationFile(character.directoryName, resource.fileName),
      destinationDirectory,
      resource.name,
    );
  }

  async deleteIllustration(
    id: string,
    resourceId: string,
  ): Promise<CharacterIllustration | undefined> {
    const character = this.assertMutableCharacter(id);
    const current = character.illustrations.find((resource) => resource.id === resourceId);
    if (!current) return undefined;
    await deleteIllustrationFile(
      this.paths.illustrationFile(character.directoryName, current.fileName),
    );
    const deleted = this.illustrations.delete(id, resourceId);
    if (deleted) this.emitPresentationChanged(id);
    return deleted;
  }

  listVoiceSamples(id: string): CharacterVoiceSample[] {
    return this.voiceSamples.list(id);
  }

  setPrimaryVoiceSample(id: string, resourceId: string): boolean {
    return this.voiceSamples.setPrimary(id, resourceId);
  }

  updateVoiceSample(
    id: string,
    resourceId: string,
    patch: CharacterVoiceSamplePatch,
  ): CharacterVoiceSample | undefined {
    this.assertMutableCharacter(id);
    return this.voiceSamples.update(id, resourceId, normalizeResourcePatch(patch));
  }

  async publishVoiceSample(id: string, input: PublishCharacterVoiceSampleInput): Promise<CharacterVoiceSample> {
    const character = this.assertMutableCharacter(id);
    const fileName = physicalName(path.basename(input.fileName));
    const displayName = sourceBaseName(fileName);
    const destination = this.paths.voiceFile(character.directoryName, fileName);
    const settings = this.settings();
    await publishVoiceFile(destination, input.bytes, settings.voice);
    try {
      const validated = await validateVoiceSampleFile(destination, settings.voice);
      return this.voiceSamples.insert(id, {
        id: randomUUID(),
        name: displayName,
        fileName,
        promptText: input.promptText.trim(),
        promptLang: input.promptLang.trim(),
        isPrimary: input.isPrimary ?? character.voiceSamples.length === 0,
        mimeType: validated.mimeType,
        byteSize: validated.byteSize,
        durationMs: validated.durationMs,
      });
    } catch (error) {
      await removeFileIfPresent(destination);
      throw error;
    }
  }

  async importVoiceSample(id: string, input: ImportCharacterVoiceSampleInput): Promise<CharacterVoiceSample> {
    const character = this.assertMutableCharacter(id);
    const settings = this.settings();
    const validated = await validateVoiceSampleFile(input.sourceFile, settings.voice);
    const files = await importVoiceFile(
      input.sourceFile,
      this.paths.voiceRoot(character.directoryName),
      settings.voice,
    );
    const destination = this.paths.voiceFile(character.directoryName, files.fileName);
    try {
      return this.voiceSamples.insert(id, {
        id: randomUUID(),
        name: files.displayName,
        fileName: files.fileName,
        promptText: input.promptText.trim(),
        promptLang: input.promptLang.trim(),
        isPrimary: input.isPrimary ?? character.voiceSamples.length === 0,
        mimeType: validated.mimeType,
        byteSize: validated.byteSize,
        durationMs: validated.durationMs,
      });
    } catch (error) {
      await removeFileIfPresent(destination);
      throw error;
    }
  }

  async exportVoiceSample(id: string, resourceId: string, destinationDirectory: string): Promise<string> {
    const character = this.getRequired(id);
    const resource = requiredResource(character.voiceSamples, resourceId, 'voice_sample');
    return exportVoiceFile(
      this.paths.voiceFile(character.directoryName, resource.fileName),
      destinationDirectory,
      resource.name,
    );
  }

  async deleteVoiceSample(id: string, resourceId: string): Promise<CharacterVoiceSample | undefined> {
    const character = this.assertMutableCharacter(id);
    const current = character.voiceSamples.find((resource) => resource.id === resourceId);
    if (!current) return undefined;
    await deleteVoiceFile(this.paths.voiceFile(character.directoryName, current.fileName));
    return this.voiceSamples.delete(id, resourceId);
  }

  inspectHealth(id: string): Promise<CharacterHealth> {
    return inspectCharacterHealth(this.getRequired(id), this.paths, this.settings());
  }

  inspectAllHealth(): Promise<CharacterHealthReport> {
    return inspectAllCharacterHealth(this.list(), this.paths, this.settings());
  }

  resolveLive2dModelDirectory(id: string, resourceId: string): string {
    const character = this.getRequired(id);
    const resource = requiredResource(character.live2dModels, resourceId, 'live2d_model');
    return this.paths.live2dModelDirectory(character.directoryName, resource.directoryName);
  }

  /**
   * 返回渲染器真正加载的 model3.json。模型入口发现规则属于 Character，
   * Server 和前端不能再次遍历 Live2D 目录并各自决定入口。
   */
  resolveLive2dModelFile(id: string, resourceId: string): string {
    return findLive2dPackageFilesSync(
      this.resolveLive2dModelDirectory(id, resourceId),
    ).modelPath;
  }

  resolveIllustrationFile(id: string, resourceId: string): string {
    const character = this.getRequired(id);
    const resource = requiredResource(character.illustrations, resourceId, 'illustration');
    return this.paths.illustrationFile(character.directoryName, resource.fileName);
  }

  resolveVoiceSampleFile(id: string, resourceId: string): string {
    const character = this.getRequired(id);
    const resource = requiredResource(character.voiceSamples, resourceId, 'voice_sample');
    return this.paths.voiceFile(character.directoryName, resource.fileName);
  }

  private createWithDirectory(input: CharacterInput, directoryName: string): Character {
    const directory = this.paths.characterDirectory(directoryName);
    if (fs.existsSync(directory)) throw new CharacterDirectoryConflictError(directoryName);
    fs.mkdirSync(directory, { recursive: false });
    try {
      return this.withResources(this.repository.insert(input, directoryName));
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private getRequired(id: string): Character {
    const character = this.get(id);
    if (!character) throw new CharacterNotFoundError(id);
    return character;
  }

  private assertMutableCharacter(id: string): Character {
    const character = this.getRequired(id);
    if (character.isBuiltin) throw new CharacterReadOnlyError(id);
    return character;
  }

  private withResources(character: Character): Character {
    return withResources(
      character,
      this.live2dModels.list(character.id),
      this.illustrations.list(character.id),
      this.voiceSamples.list(character.id),
    );
  }

  private insertLive2dModel(
    id: string,
    input: CharacterLive2dModelInput & { id: string },
    vocabulary: Live2dVocabulary,
  ): CharacterLive2dModel {
    const character = this.getRequired(id);
    const becomesPrimary = input.enabled !== false
      && (input.isPrimary === true || !selectPrimaryLive2dModel(character.live2dModels));
    return this.sqlite.transaction(() => {
      const inserted = this.live2dModels.insert(id, { ...input, isPrimary: becomesPrimary });
      if (becomesPrimary) this.writeVocabulary(id, inserted.id, vocabulary);
      return this.live2dModels.list(id).find((resource) => resource.id === inserted.id)!;
    })();
  }

  private deleteLive2dModelRecord(
    character: Character,
    current: CharacterLive2dModel,
  ): CharacterLive2dModel | undefined {
    const nextPrimary = current.isPrimary
      ? selectPrimaryLive2dModel(character.live2dModels.filter((resource) => resource.id !== current.id))
      : null;
    const vocabulary = nextPrimary ? this.readVocabulary(character, nextPrimary) : EMPTY_VOCABULARY;
    return this.sqlite.transaction(() => {
      const deleted = this.live2dModels.delete(character.id, current.id);
      if (deleted && nextPrimary) this.writeVocabulary(character.id, nextPrimary.id, vocabulary);
      return deleted;
    })();
  }

  private refreshPrimaryLive2dVocabulary(id: string): void {
    const character = this.getRequired(id);
    const primary = selectPrimaryLive2dModel(character.live2dModels);
    if (!primary) return;
    this.writeVocabulary(id, primary.id, this.readVocabulary(character, primary));
  }

  private readVocabulary(
    character: Character,
    resource: Pick<CharacterLive2dModel, 'directoryName'>,
  ): Live2dVocabulary {
    const directory = this.paths.live2dModelDirectory(
      character.directoryName,
      resource.directoryName,
    );
    if (!fs.existsSync(directory)) {
      // 内置种子的正式资源由发布装配复制；开发期资源尚未安装时允许空词汇。
      if (character.isBuiltin) return EMPTY_VOCABULARY;
      throw new CharacterResourceMissingError('live2d_model', directory);
    }
    const { runtimeConfigPath } = findLive2dPackageFilesSync(directory);
    return readLive2dVocabulary(
      runtimeConfigPath,
      this.settings().live2d.maxRuntimeConfigBytes,
    );
  }

  private writeVocabulary(
    id: string,
    live2dModelId: string,
    vocabulary: Live2dVocabulary,
  ): void {
    const current = this.live2dModels.list(id).find(
      (resource) => resource.id === live2dModelId,
    );
    if (!current || (
      sameWords(current.emotionVocabulary, vocabulary.emotions)
      && sameWords(current.motionVocabulary, vocabulary.motions)
    )) return;
    this.live2dModels.updateVocabularies(
      id,
      live2dModelId,
      vocabulary.emotions,
      vocabulary.motions,
    );
  }

  private settings(): CharacterSettings {
    return readCharacterSettings(this.settingsStore);
  }

  private emitSwitched(next: Character, previous: Character | null): void {
    for (const listener of this.switchedListeners) {
      try { listener(next, previous); }
      catch (error) { console.error('[character] switched listener threw:', error); }
    }
  }

  private emitPresentationChanged(id: string): void {
    const character = this.get(id);
    if (!character) return;
    for (const listener of this.presentationChangedListeners) {
      try { listener(character); }
      catch (error) { console.error('[character] presentation listener threw:', error); }
    }
  }
}

const EMPTY_VOCABULARY: Live2dVocabulary = { emotions: [], motions: [] };

function normalizeCharacterInput(input: CharacterInput): {
  name: string;
  description: string | null;
  personaPrompt: string;
} {
  const name = input.name.trim();
  if (!name) throw new CharacterInputInvalidError('character_name_empty');
  return {
    name,
    description: input.description?.trim() || null,
    personaPrompt: input.personaPrompt.trim(),
  };
}

function withResources(
  character: Character,
  live2dModels: readonly CharacterLive2dModel[],
  illustrations: readonly CharacterIllustration[],
  voiceSamples: readonly CharacterVoiceSample[],
): Character {
  const primary = selectPrimaryLive2dModel(live2dModels);
  return {
    ...character,
    live2dModels,
    illustrations,
    voiceSamples,
    emotionVocabulary: primary?.emotionVocabulary ?? [],
    motionVocabulary: primary?.motionVocabulary ?? [],
  };
}

function selectPrimaryLive2dModel(resources: readonly CharacterLive2dModel[]): CharacterLive2dModel | undefined {
  const enabled = resources.filter((resource) => resource.enabled);
  return enabled.find((resource) => resource.isPrimary)
    ?? enabled.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0];
}

function normalizeResourcePatch<T extends {
  name?: string;
  stageScale?: number;
  stageOffsetX?: number;
  stageOffsetY?: number;
  enabled?: boolean;
}>(patch: T): T {
  if (Object.values(patch).every((value) => value === undefined)) {
    throw new CharacterInputInvalidError('resource_patch_empty');
  }
  if (patch.name !== undefined && !patch.name.trim()) {
    throw new CharacterInputInvalidError('resource_name_empty');
  }
  if (patch.stageScale !== undefined && (
    !Number.isFinite(patch.stageScale) || patch.stageScale < 0.1 || patch.stageScale > 5
  )) throw new CharacterInputInvalidError('resource_stage_scale_invalid');
  for (const offset of [patch.stageOffsetX, patch.stageOffsetY]) {
    if (offset !== undefined && (!Number.isFinite(offset) || offset < -1 || offset > 1)) {
      throw new CharacterInputInvalidError('resource_stage_offset_invalid');
    }
  }
  return patch.name === undefined ? patch : { ...patch, name: patch.name.trim() };
}

function requiredResource<T extends { id: string }>(
  resources: readonly T[],
  id: string,
  kind: CharacterResourceKind,
): T {
  const resource = resources.find((item) => item.id === id);
  if (!resource) throw new CharacterResourceNotFoundError(kind, id);
  return resource;
}

function sameWords(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
