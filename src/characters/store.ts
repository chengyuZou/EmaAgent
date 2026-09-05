import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import type { CharacterDeleteResult, Database } from '@ema-agent/storage';
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
  CharacterStagePresentation,
  CharacterIllustrationStageEntry,
} from './types.js';
import { CharacterRepository } from './repository.js';
import { EMA_CHARACTER_NAME, BUILTIN_CHARACTERS } from './seed/index.js';
import type {
  CharacterLive2dModel,
  CharacterLive2dModelInput,
  CharacterLive2dModelPatch,
  ImportCharacterLive2dModelInput,
  Live2dConfiguration,
  Live2dMappings,
} from './live2d/types.js';
import { CharacterLive2dModelRepository } from './live2d/repository.js';
import { extractLive2dRuntimeConfig } from './live2d/live2dRuntimeConfigExtraction.js';
import { supplementLive2dRuntimeConfig } from './live2d/live2dRuntimeConfigSupplement.js';
import { readLive2dRuntimeConfig, writeLive2dMappings } from './live2d/live2dRuntimeConfig.js';
import {
  deleteLive2dDirectory,
  exportLive2dZip,
  findLive2dFiles,
  findLive2dFilesSync,
  importLive2dFiles,
} from './live2d/live2dFiles.js';
import type {
  CharacterIllustration,
  CharacterIllustrationPatch,
  ImportCharacterIllustrationInput,
} from './illustration/types.js';
import { CharacterIllustrationRepository } from './illustration/repository.js';
import { ILLUSTRATION_EXPRESSION_POOL_MAX } from './illustration/limits.js';
import {
  exportIllustrationFile,
  importIllustrationFile,
  inspectIllustrationFileSync,
} from './illustration/illustrationFiles.js';
import type {
  CharacterVoiceSample,
  CharacterVoiceSamplePatch,
  ImportCharacterVoiceSampleInput,
} from './voice/types.js';
import { CharacterVoiceSampleRepository } from './voice/repository.js';
import { validateVoiceSampleFile } from './voice/voiceSampleValidator.js';
import {
  exportVoiceFile,
  importVoiceFile,
} from './voice/voiceFiles.js';
import { CharacterResourcePaths, physicalName } from './resources/resourcePaths.js';
import { removeDirectoryIfPresent, removeFileIfPresent } from './resources/resourceFiles.js';
import { assertPersonaPrompt } from './characterPrompt.js';
import {
  CharacterDirectoryConflictError,
  CharacterInputInvalidError,
  CharacterNotFoundError,
  CharacterResourceNotFoundError,
  CharacterResourceValidationError,
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

export class CharacterStore {
  private readonly repository: CharacterRepository;
  private readonly live2dModels: CharacterLive2dModelRepository;
  private readonly illustrations: CharacterIllustrationRepository;
  private readonly voiceSamples: CharacterVoiceSampleRepository;
  private readonly paths: CharacterResourcePaths;
  private readonly switchedListeners = new Set<CharacterSwitchedListener>();
  private readonly presentationChangedListeners = new Set<CharacterPresentationChangedListener>();
  // Promise 尾链只按稳定角色名分组，避免同一角色的文件操作与 SQL 提交互相覆盖。
  private readonly mutationTails = new Map<string, Promise<void>>();

  constructor(db: Database, charactersRoot: string) {
    fs.mkdirSync(charactersRoot, { recursive: true });
    this.repository = new CharacterRepository(new CharacterRepo(db.sqlite));
    this.live2dModels = new CharacterLive2dModelRepository(new CharacterLive2dModelRepo(db.sqlite));
    this.illustrations = new CharacterIllustrationRepository(new CharacterIllustrationRepo(db.sqlite));
    this.voiceSamples = new CharacterVoiceSampleRepository(new CharacterVoiceSampleRepo(db.sqlite));
    this.paths = new CharacterResourcePaths(charactersRoot);
    // `.staging` 只存尚未提交的操作；Server 重启后没有任何任务能继续使用其中内容。
    fs.rmSync(this.paths.stagingRoot(), { recursive: true, force: true });
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
      assertPersonaPrompt(input.personaPrompt, input.name);
      if (!this.repository.findByName(input.name)) {
        this.repository.insert(input, seed.stageKind);
      }
      for (const model of seed.live2dModels) {
        if (!this.live2dModels.list(input.name).some(item => item.name === model.name)) {
          this.live2dModels.insert(input.name, model);
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
    if (!this.repository.findActive()) {
      this.repository.activate(EMA_CHARACTER_NAME);
      const active = this.get(EMA_CHARACTER_NAME);
      if (active) this.emitSwitched(active);
    }
  }

  current(): Character {
    const character = this.repository.findActive();
    if (!character) throw new CharacterStateInvalidError('active_character_missing');
    return this.withResources(character);
  }
  list(): Character[] {
    const characters = this.repository.list();
    const names = characters.map(character => character.name);
    const live2d = this.live2dModels.listForCharacters(names);
    const illustrations = this.illustrations.listForCharacters(names);
    const voices = this.voiceSamples.listForCharacters(names);
    return characters.map(character => withResources(
      character,
      live2d.get(character.name) ?? [],
      illustrations.get(character.name) ?? [],
      voices.get(character.name) ?? [],
    ));
  }
  get(name: string): Character | undefined {
    const character = this.repository.findByName(name);
    return character ? this.withResources(character) : undefined;
  }

  create(input: CharacterInput): Character {
    const normalized = normalizeCharacterInput(input);
    assertPersonaPrompt(normalized.personaPrompt, normalized.name);
    if (normalized.name.toLowerCase() === '.staging') {
      throw new CharacterDirectoryConflictError(normalized.name);
    }
    const directory = this.paths.characterDirectory(normalized.name);
    if (fs.existsSync(directory) || this.repository.findByName(normalized.name)) {
      throw new CharacterDirectoryConflictError(normalized.name);
    }
    // 先占住稳定目录名；SQL 创建失败时撤销目录，不能留下无法再次创建的幽灵角色。
    fs.mkdirSync(directory, { recursive: false });
    try {
      return this.withResources(this.repository.insert(normalized));
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  update(name: string, patch: CharacterPatch): Promise<Character> {
    return this.mutate(name, () => {
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
      this.repository.update(name, normalized);
      const updated = this.get(name) ?? current;
      if (patch.stageKind !== undefined) this.emitPresentationChanged(name);
      return updated;
    });
  }

  activate(name: string): string {
    const target = this.getRequired(name);
    assertPersonaPrompt(target.personaPrompt, name);
    const previous = this.repository.findActive();
    if (!this.repository.activate(name)) {
      throw new CharacterNotFoundError(name);
    }
    const next = this.getRequired(name);
    if (!previous || previous.name !== name) {
      this.emitSwitched(next);
    }
    return name;
  }

  deleteCharacter(name: string, replacementName?: string): Promise<CharacterDeleteResult> {
    return this.mutate(name, async () => {
      this.getRequiredCharacterOnly(name);
      const operationDirectory = this.createStagingOperation();
      const characterDirectory = this.paths.characterDirectory(name);
      // 目录先移入本次操作的暂存区，SQL 拒绝删除或抛错时再原位恢复。
      // 当前角色的替代激活与角色删除由 Repository 在同一事务中完成。
      const staged = await this.stageExistingPath(characterDirectory, operationDirectory);
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

  setPrimaryLive2dModel(characterName: string, live2dName: string): Promise<boolean> {
    return this.mutate(characterName, () => {
      this.getRequiredCharacterOnly(characterName);
      if (!this.live2dModels.find(characterName, live2dName)) {
        throw new CharacterResourceNotFoundError('live2d_model', live2dName);
      }
      const changed = this.live2dModels.setPrimary(characterName, live2dName);
      if (changed) this.resourceChanged(characterName);
      return changed;
    });
  }

  updateLive2dModel(characterName: string, live2dName: string, patch: CharacterLive2dModelPatch): Promise<CharacterLive2dModel | undefined> {
    return this.mutate(characterName, () => {
      this.getRequiredCharacterOnly(characterName);
      normalizeResourcePatch(patch);
      const resource = this.live2dModels.update(characterName, live2dName, patch);
      if (resource) this.resourceChanged(characterName);
      return resource;
    });
  }
  async importLive2dModel(characterName: string, input: ImportCharacterLive2dModelInput): Promise<CharacterLive2dModel> {
    return this.mutate(characterName, async () => {
      this.getRequiredCharacterOnly(characterName);
      // 导入先在角色目录之外完成解压、引用校验与配置补充；全部通过后才改名提交。
      const operationDirectory = this.createStagingOperation();
      const stagedDirectory = path.join(operationDirectory, 'resource');
      let destination: string | undefined;
      try {
        const files = await importLive2dFiles(input.source, stagedDirectory);
        destination = this.paths.live2dModelDirectory(characterName, files.name);
        if (fs.existsSync(destination) || this.live2dModels.find(characterName, files.name)) {
          throw new CharacterResourceValidationError('resource_name_conflict');
        }
        const live2dFiles = await findLive2dFiles(stagedDirectory);
        const extraction = await extractLive2dRuntimeConfig(stagedDirectory, live2dFiles.modelPath);
        await supplementLive2dRuntimeConfig(
          live2dFiles.modelPath,
          live2dFiles.runtimeConfigPath,
          extraction,
        );
        await fs.promises.mkdir(this.paths.live2dRoot(characterName), { recursive: true });
        await fs.promises.rename(stagedDirectory, destination);
        try {
          const resource = this.live2dModels.insert(characterName, {
            name: files.name,
            displayName: files.displayName,
            isPrimary: input.isPrimary,
            byteSize: files.byteSize,
          });
          this.resourceChanged(characterName);
          return resource;
        } catch (error) {
          await deleteLive2dDirectory(destination);
          throw error;
        }
      } finally {
        await removeDirectoryIfPresent(operationDirectory);
      }
    });
  }
  async exportLive2dModel(characterName: string, live2dName: string, destination: string): Promise<string> {
    this.getRequiredCharacterOnly(characterName);
    const resource = this.live2dModels.find(characterName, live2dName);
    if (!resource) throw new CharacterResourceNotFoundError('live2d_model', live2dName);
    return exportLive2dZip(
      this.paths.live2dModelDirectory(characterName, live2dName),
      destination,
      resource.displayName,
    );
  }
  async deleteLive2dModel(characterName: string, live2dName: string): Promise<CharacterLive2dModel | undefined> {
    return this.mutate(characterName, async () => {
      this.getRequiredCharacterOnly(characterName);
      const current = this.live2dModels.find(characterName, live2dName);
      if (!current) return undefined;
      const operationDirectory = this.createStagingOperation();
      const source = this.paths.live2dModelDirectory(characterName, live2dName);
      const staged = await this.stageExistingPath(source, operationDirectory);
      try {
        const deleted = this.live2dModels.delete(characterName, live2dName);
        if (!deleted && staged) await fs.promises.rename(staged, source);
        if (deleted) this.resourceChanged(characterName);
        return deleted;
      } catch (error) {
        if (staged && !fs.existsSync(source)) await fs.promises.rename(staged, source);
        throw error;
      } finally {
        await removeDirectoryIfPresent(operationDirectory);
      }
    });
  }

  setPrimaryIllustration(characterName: string, illustrationName: string): Promise<boolean> {
    return this.mutate(characterName, () => {
      this.getRequiredCharacterOnly(characterName);
      if (!this.illustrations.find(characterName, illustrationName)) {
        throw new CharacterResourceNotFoundError('illustration', illustrationName);
      }
      const changed = this.illustrations.setPrimary(characterName, illustrationName);
      if (changed) this.resourceChanged(characterName);
      return changed;
    });
  }

  updateIllustration(characterName: string, illustrationName: string, patch: CharacterIllustrationPatch): Promise<CharacterIllustration | undefined> {
    return this.mutate(characterName, () => {
      this.getRequiredCharacterOnly(characterName);
      normalizeResourcePatch(patch);
      normalizeExpression(patch.expression);
      this.assertExpressionCapacity(characterName, patch.expression, illustrationName);
      const resource = this.illustrations.update(characterName, illustrationName, patch);
      if (resource) this.resourceChanged(characterName);
      return resource;
    });
  }
  async importIllustration(characterName: string, input: ImportCharacterIllustrationInput): Promise<CharacterIllustration> {
    return this.mutate(characterName, async () => {
      this.getRequiredCharacterOnly(characterName);
      normalizeExpression(input.expression);
      this.assertExpressionCapacity(characterName, input.expression);
      const operationDirectory = this.createStagingOperation();
      const stagedFile = path.join(operationDirectory, 'resource');
      let destination: string | undefined;
      try {
        const files = await importIllustrationFile(input.sourceFile, stagedFile);
        destination = this.paths.illustrationFile(characterName, files.name);
        if (fs.existsSync(destination) || this.illustrations.find(characterName, files.name)) {
          throw new CharacterResourceValidationError('resource_name_conflict');
        }
        await fs.promises.mkdir(this.paths.illustrationRoot(characterName), { recursive: true });
        await fs.promises.rename(stagedFile, destination);
        try {
          const resource = this.illustrations.insert(characterName, {
            name: files.name,
            displayName: files.displayName,
            expression: input.expression ?? null,
            isPrimary: input.isPrimary,
            byteSize: files.byteSize,
          });
          this.resourceChanged(characterName);
          return resource;
        } catch (error) {
          await removeFileIfPresent(destination);
          throw error;
        }
      } finally {
        await removeDirectoryIfPresent(operationDirectory);
      }
    });
  }
  async exportIllustration(characterName: string, illustrationName: string, destination: string): Promise<string> {
    this.getRequiredCharacterOnly(characterName);
    const resource = this.illustrations.find(characterName, illustrationName);
    if (!resource) throw new CharacterResourceNotFoundError('illustration', illustrationName);
    return exportIllustrationFile(
      this.paths.illustrationFile(characterName, illustrationName),
      destination,
      resource.displayName,
    );
  }
  async deleteIllustration(characterName: string, illustrationName: string): Promise<CharacterIllustration | undefined> {
    return this.mutate(characterName, async () => {
      this.getRequiredCharacterOnly(characterName);
      const current = this.illustrations.find(characterName, illustrationName);
      if (!current) return undefined;
      const operationDirectory = this.createStagingOperation();
      const source = this.paths.illustrationFile(characterName, illustrationName);
      const staged = await this.stageExistingPath(source, operationDirectory);
      try {
        const deleted = this.illustrations.delete(characterName, illustrationName);
        if (!deleted && staged) await fs.promises.rename(staged, source);
        if (deleted) this.resourceChanged(characterName);
        return deleted;
      } catch (error) {
        if (staged && !fs.existsSync(source)) await fs.promises.rename(staged, source);
        throw error;
      } finally {
        await removeDirectoryIfPresent(operationDirectory);
      }
    });
  }

  setPrimaryVoiceSample(characterName: string, voiceName: string): Promise<boolean> {
    return this.mutate(characterName, () => {
      this.getRequiredCharacterOnly(characterName);
      if (!this.voiceSamples.find(characterName, voiceName)) {
        throw new CharacterResourceNotFoundError('voice_sample', voiceName);
      }
      const changed = this.voiceSamples.setPrimary(characterName, voiceName);
      if (changed) this.resourceChanged(characterName);
      return changed;
    });
  }

  updateVoiceSample(characterName: string, voiceName: string, patch: CharacterVoiceSamplePatch): Promise<CharacterVoiceSample | undefined> {
    return this.mutate(characterName, () => {
      this.getRequiredCharacterOnly(characterName);
      normalizeResourcePatch(patch);
      const resource = this.voiceSamples.update(characterName, voiceName, patch);
      if (resource) this.resourceChanged(characterName);
      return resource;
    });
  }
  async importVoiceSample(characterName: string, input: ImportCharacterVoiceSampleInput): Promise<CharacterVoiceSample> {
    return this.mutate(characterName, async () => {
      this.getRequiredCharacterOnly(characterName);
      const promptText = input.promptText.trim();
      const promptLang = input.promptLang.trim();
      if (!promptText || !promptLang) {
        throw new CharacterInputInvalidError('voice_prompt_required', characterName);
      }
      const validated = await validateVoiceSampleFile(input.sourceFile);
      const operationDirectory = this.createStagingOperation();
      const stagedFile = path.join(operationDirectory, 'resource');
      let destination: string | undefined;
      try {
        const files = await importVoiceFile(input.sourceFile, stagedFile);
        destination = this.paths.voiceFile(characterName, files.name);
        if (fs.existsSync(destination) || this.voiceSamples.find(characterName, files.name)) {
          throw new CharacterResourceValidationError('resource_name_conflict');
        }
        await fs.promises.mkdir(this.paths.voiceRoot(characterName), { recursive: true });
        await fs.promises.rename(stagedFile, destination);
        try {
          const resource = this.voiceSamples.insert(characterName, {
            name: files.name,
            displayName: files.displayName,
            promptText,
            promptLang,
            isPrimary: input.isPrimary,
            mimeType: validated.mimeType,
            byteSize: validated.byteSize,
            durationMs: validated.durationMs,
          });
          this.resourceChanged(characterName);
          return resource;
        } catch (error) {
          await removeFileIfPresent(destination);
          throw error;
        }
      } finally {
        await removeDirectoryIfPresent(operationDirectory);
      }
    });
  }
  async exportVoiceSample(characterName: string, voiceName: string, destination: string): Promise<string> {
    this.getRequiredCharacterOnly(characterName);
    const resource = this.voiceSamples.find(characterName, voiceName);
    if (!resource) throw new CharacterResourceNotFoundError('voice_sample', voiceName);
    return exportVoiceFile(
      this.paths.voiceFile(characterName, voiceName),
      destination,
      resource.displayName,
    );
  }
  async deleteVoiceSample(characterName: string, voiceName: string): Promise<CharacterVoiceSample | undefined> {
    return this.mutate(characterName, async () => {
      this.getRequiredCharacterOnly(characterName);
      const current = this.voiceSamples.find(characterName, voiceName);
      if (!current) return undefined;
      const operationDirectory = this.createStagingOperation();
      const source = this.paths.voiceFile(characterName, voiceName);
      const staged = await this.stageExistingPath(source, operationDirectory);
      try {
        const deleted = this.voiceSamples.delete(characterName, voiceName);
        if (!deleted && staged) await fs.promises.rename(staged, source);
        if (deleted) this.resourceChanged(characterName);
        return deleted;
      } catch (error) {
        if (staged && !fs.existsSync(source)) await fs.promises.rename(staged, source);
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

  inspectStagePresentation(characterName: string): CharacterStagePresentation {
    // Prompt、StageEngine 初始化和角色事件仍是同步消费方，因此这里只读取已提交资源，
    // 不触发导入、修复或异步补全，也不缓存另一份可能过期的舞台事实。
    const character = this.repository.findByName(characterName);
    if (!character) throw new CharacterNotFoundError(characterName);
    if (character.stageKind === 'blank') {
      return { status: 'blank', characterName };
    }
    if (character.stageKind === 'live2d') {
      const resource = this.live2dModels.findPrimary(characterName);
      if (!resource) {
        return { status: 'unavailable', characterName, stageKind: 'live2d', reason: 'primary_resource_missing' };
      }
      try {
        const directory = this.paths.live2dModelDirectory(characterName, resource.name);
        const files = findLive2dFilesSync(directory);
        return {
          status: 'live2d',
          characterName,
          resource: {
            kind: 'live2d',
            name: resource.name,
            displayName: resource.displayName,
            file: files.modelPath,
            stageScale: resource.stageScale,
            stageOffsetX: resource.stageOffsetX,
            stageOffsetY: resource.stageOffsetY,
            runtimeConfig: files.runtimeConfigPath ? readLive2dRuntimeConfig(files.runtimeConfigPath) : null,
          },
        };
      } catch {
        return {
          status: 'unavailable',
          characterName,
          stageKind: 'live2d',
          reason: fs.existsSync(this.paths.live2dModelDirectory(characterName, resource.name)) ? 'resource_invalid' : 'resource_file_missing',
        };
      }
    }
    const resource = this.illustrations.findPrimary(characterName);
    if (!resource) {
      return { status: 'unavailable', characterName, stageKind: 'illustration', reason: 'primary_resource_missing' };
    }
    const file = this.paths.illustrationFile(characterName, resource.name);
    const primaryFileState = inspectIllustrationFileSync(file);
    if (primaryFileState !== 'valid') {
      return {
        status: 'unavailable',
        characterName,
        stageKind: 'illustration',
        reason: primaryFileState === 'missing' ? 'resource_file_missing' : 'resource_invalid',
      };
    }
    const expressions: Record<string, CharacterIllustrationStageEntry[]> = {};
    for (const item of this.illustrations.list(characterName)) {
      if (!item.expression) continue;
      const itemFile = this.paths.illustrationFile(characterName, item.name);
      if (inspectIllustrationFileSync(itemFile) !== 'valid') continue;
      (expressions[item.expression] ??= []).push(illustrationStageEntry(item, itemFile));
    }
    return { status: 'illustration', characterName, resource: illustrationStageEntry(resource, file), expressions };
  }

  resolveLive2dModelDirectory(characterName: string, live2dName: string): string {
    this.getRequiredCharacterOnly(characterName);
    if (!this.live2dModels.find(characterName, live2dName)) {
      throw new CharacterResourceNotFoundError('live2d_model', live2dName);
    }
    return this.paths.live2dModelDirectory(characterName, live2dName);
  }

  resolveIllustrationFile(characterName: string, illustrationName: string): string {
    this.getRequiredCharacterOnly(characterName);
    if (!this.illustrations.find(characterName, illustrationName)) {
      throw new CharacterResourceNotFoundError('illustration', illustrationName);
    }
    return this.paths.illustrationFile(characterName, illustrationName);
  }

  resolveVoiceSampleFile(characterName: string, voiceName: string): string {
    this.getRequiredCharacterOnly(characterName);
    if (!this.voiceSamples.find(characterName, voiceName)) {
      throw new CharacterResourceNotFoundError('voice_sample', voiceName);
    }
    return this.paths.voiceFile(characterName, voiceName);
  }

  async reloadLive2dConfiguration(characterName: string, live2dName: string): Promise<Live2dConfiguration> {
    return this.mutate(characterName, async () => {
      const configuration = await this.readLive2dConfiguration(characterName, live2dName);
      this.resourceChanged(characterName);
      return configuration;
    });
  }
  async readLive2dConfiguration(characterName: string, live2dName: string): Promise<Live2dConfiguration> {
    this.getRequiredCharacterOnly(characterName);
    if (!this.live2dModels.find(characterName, live2dName)) {
      throw new CharacterResourceNotFoundError('live2d_model', live2dName);
    }
    const directory = this.paths.live2dModelDirectory(characterName, live2dName);
    const files = await findLive2dFiles(directory);
    const extraction = await extractLive2dRuntimeConfig(directory, files.modelPath);
    return {
      runtimeConfig: readLive2dRuntimeConfig(files.runtimeConfigPath),
      expressions: extraction.expressions.map(expression => expression.name),
      motions: extraction.motions,
    };
  }
  async saveLive2dMappings(characterName: string, live2dName: string, mappings: Live2dMappings): Promise<Live2dConfiguration> {
    return this.mutate(characterName, async () => {
      this.getRequiredCharacterOnly(characterName);
      if (!this.live2dModels.find(characterName, live2dName)) {
        throw new CharacterResourceNotFoundError('live2d_model', live2dName);
      }
      const directory = this.paths.live2dModelDirectory(characterName, live2dName);
      const files = await findLive2dFiles(directory);
      const extraction = await extractLive2dRuntimeConfig(directory, files.modelPath);
      const written = await writeLive2dMappings(
        files.modelPath,
        files.runtimeConfigPath,
        mappings,
        extraction.expressions.map(expression => expression.name),
        extraction.motions,
      );
      this.resourceChanged(characterName);
      return {
        runtimeConfig: written.config,
        expressions: extraction.expressions.map(expression => expression.name),
        motions: extraction.motions,
      };
    });
  }

  private getRequired(name: string): Character {
    const character = this.get(name);
    if (!character) throw new CharacterNotFoundError(name);
    return character;
  }

  private getRequiredCharacterOnly(name: string): Character {
    // 只需确认身份时不加载三类资源，避免一次资源操作先额外查询完整角色聚合。
    const character = this.repository.findByName(name);
    if (!character) throw new CharacterNotFoundError(name);
    return character;
  }

  private withResources(character: Character): Character {
    return withResources(
      character,
      this.live2dModels.list(character.name),
      this.illustrations.list(character.name),
      this.voiceSamples.list(character.name),
    );
  }
  private assertExpressionCapacity(characterName: string, expression: string | null | undefined, excludingName?: string): void {
    if (!expression) return;
    // 编辑已有立绘时排除自身，否则把不改变 expression 的保存误判为超额。
    const count = this.illustrations.list(characterName)
      .filter(resource => resource.name !== excludingName && resource.expression === expression).length;
    if (count >= ILLUSTRATION_EXPRESSION_POOL_MAX) {
      throw new CharacterInputInvalidError('illustration_expression_pool_full', characterName);
    }
  }

  /** 同一角色的文件与 SQL 修改串行；不同角色仍可并发导入和编辑。 */
  private mutate<T>(characterName: string, action: () => T | Promise<T>): Promise<T> {
    const previous = this.mutationTails.get(characterName) ?? Promise.resolve();
    const result = previous.then(action);
    const tail = result.then(() => undefined, () => undefined);
    this.mutationTails.set(characterName, tail);
    void tail.then(() => {
      if (this.mutationTails.get(characterName) === tail) {
        this.mutationTails.delete(characterName);
      }
    });
    return result;
  }

  private createStagingOperation(): string {
    const directory = this.paths.stagingOperationDirectory(crypto.randomUUID());
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }

  private async stageExistingPath(source: string, operationDirectory: string): Promise<string | null> {
    if (!await fs.promises.stat(source).catch(() => null)) return null;
    // 每次操作拥有独立 UUID 目录，因此固定使用 `deleted` 不会与其他角色操作冲突。
    const staged = path.join(operationDirectory, 'deleted');
    await fs.promises.rename(source, staged);
    return staged;
  }

  private resourceChanged(characterName: string): void {
    // 资源表自身的时间不足以刷新角色卡；同时推进角色更新时间并广播新的舞台事实。
    this.repository.touch(characterName);
    this.emitPresentationChanged(characterName);
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

function withResources(
  character: Character,
  live2dModels: readonly CharacterLive2dModel[],
  illustrations: readonly CharacterIllustration[],
  voiceSamples: readonly CharacterVoiceSample[],
): Character {
  return { ...character, live2dModels, illustrations, voiceSamples };
}

function normalizeResourcePatch(patch: {
  displayName?: string;
  stageScale?: number;
  stageOffsetX?: number;
  stageOffsetY?: number;
}): void {
  if (Object.values(patch).every(value => value === undefined)) {
    throw new CharacterInputInvalidError('resource_patch_empty');
  }
  if (patch.displayName !== undefined && !patch.displayName.trim()) {
    throw new CharacterInputInvalidError('resource_name_empty');
  }
  if (patch.stageScale !== undefined && (!Number.isFinite(patch.stageScale) || patch.stageScale < 0.1 || patch.stageScale > 5)) {
    throw new CharacterInputInvalidError('resource_stage_scale_invalid');
  }
  for (const value of [patch.stageOffsetX, patch.stageOffsetY]) {
    if (value !== undefined && (!Number.isFinite(value) || value < -1 || value > 1)) {
      throw new CharacterInputInvalidError('resource_stage_offset_invalid');
    }
  }
}

function normalizeExpression(expression: string | null | undefined): void {
  if (expression !== undefined && expression !== null && !/^[a-z][a-z0-9_]*$/u.test(expression)) {
    throw new CharacterInputInvalidError('illustration_expression_invalid');
  }
}

function illustrationStageEntry(resource: CharacterIllustration, file: string): CharacterIllustrationStageEntry {
  return {
    kind: 'illustration',
    name: resource.name,
    displayName: resource.displayName,
    file,
    stageScale: resource.stageScale,
    stageOffsetX: resource.stageOffsetX,
    stageOffsetY: resource.stageOffsetY,
  };
}
