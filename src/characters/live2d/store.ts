import { CharacterLive2dModelRepo, type CharacterLive2dModelRow } from '@ema-agent/storage';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { CharacterMutations, assertResourcePatch } from '../resources/characterMutations.js';
import { removeDirectoryIfPresent } from '../resources/resourceFiles.js';
import { CharacterResourceNotFoundError, CharacterResourceValidationError } from '../errors.js';
import type { CharacterStagePresentation } from '../types.js';
import type {
  CharacterLive2dModel,
  CharacterLive2dModelInput,
  CharacterLive2dModelPatch,
  PrepareCharacterLive2dImportInput,
  PreparedLive2dImport,
  Live2dConfiguration,
  Live2dMappings,
} from './types.js';
import { readLive2dModelResources } from './live2dModelResources.js';
import { assertLive2dMappings } from './live2dMappings.js';
import {
  createLive2dArchiveStream,
  exportLive2dZip,
  findLive2dFiles,
  findLive2dFilesSync,
  importLive2dFiles,
  live2dDirectoryByteSizeSync,
  type ImportedLive2dFiles,
} from './live2dFiles.js';

interface PreparedLive2dImportEntry {
  readonly characterName: string;
  readonly operationDirectory: string;
  readonly resourceDirectory: string;
  readonly files: ImportedLive2dFiles;
}


function fromRow(row: CharacterLive2dModelRow): CharacterLive2dModel {
  return {
    name: row.name,
    characterName: row.character_name,
    displayName: row.display_name,
    emotionMap: JSON.parse(row.emotion_map_json) as Live2dMappings['emotionMap'],
    motionMap: JSON.parse(row.motion_map_json) as Live2dMappings['motionMap'],
    stageScale: row.stage_scale,
    stageOffsetX: row.stage_offset_x,
    stageOffsetY: row.stage_offset_y,
    isPrimary: row.is_primary === 1,
    byteSize: row.byte_size,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CharacterLive2dStore {
  private readonly preparedLive2dImports = new Map<string, PreparedLive2dImportEntry>();
  constructor(
    private readonly repo: CharacterLive2dModelRepo,
    private readonly mutations: CharacterMutations,
  ) {}

  list(characterName: string): CharacterLive2dModel[] {
    return this.repo.listForCharacter(characterName).map(fromRow);
  }

  find(characterName: string, name: string): CharacterLive2dModel | undefined {
    const row = this.repo.find(characterName, name);
    return row ? fromRow(row) : undefined;
  }

  findPrimary(characterName: string): CharacterLive2dModel | undefined {
    const row = this.repo.findPrimary(characterName);
    return row ? fromRow(row) : undefined;
  }

  listForCharacters(characterNames: readonly string[]): Map<string, CharacterLive2dModel[]> {
    const grouped = new Map<string, CharacterLive2dModel[]>();
    for (const row of this.repo.listForCharacters(characterNames)) {
      const list = grouped.get(row.character_name) ?? [];
      list.push(fromRow(row));
      grouped.set(row.character_name, list);
    }
    return grouped;
  }

  insert(characterName: string, input: CharacterLive2dModelInput): CharacterLive2dModel {
    const now = Date.now();
    this.repo.insert({
      ...input,
      characterName,
      emotionMapJson: JSON.stringify(input.emotionMap ?? {}),
      motionMapJson: JSON.stringify(input.motionMap ?? {}),
      createdAt: now,
      updatedAt: now,
    });
    return fromRow(this.repo.find(characterName, input.name)!);
  }

  private setPrimaryRecord(characterName: string, name: string): boolean {
    return this.repo.setPrimary(characterName, name, Date.now());
  }

  private updateRecord(characterName: string, name: string, patch: CharacterLive2dModelPatch): CharacterLive2dModel | undefined {
    const row = this.repo.update(characterName, name, patch, Date.now());
    return row ? fromRow(row) : undefined;
  }

  private updateMappingsRecord(characterName: string, name: string, mappings: Live2dMappings): CharacterLive2dModel | undefined {
    const row = this.repo.updateMappings(
      characterName,
      name,
      JSON.stringify(mappings.emotionMap),
      JSON.stringify(mappings.motionMap),
      Date.now(),
    );
    return row ? fromRow(row) : undefined;
  }

  updateByteSize(characterName: string, name: string, byteSize: number): void {
    this.repo.updateByteSize(characterName, name, byteSize);
  }

  private deleteRecord(characterName: string, name: string): CharacterLive2dModel | undefined {
    const row = this.repo.delete(characterName, name);
    return row ? fromRow(row) : undefined;
  }

  setPrimary(characterName: string, live2dName: string): Promise<boolean> {
    return this.mutations.run(characterName, () => {
      const character = this.mutations.requireCharacter(characterName);
      if (!this.find(characterName, live2dName)) {
        throw new CharacterResourceNotFoundError('live2d_model', live2dName);
      }
      const changed = this.setPrimaryRecord(characterName, live2dName);
      if (changed) {
        this.mutations.resourcesChanged(characterName);
        if (character.stageKind === 'live2d') this.mutations.presentationChanged(characterName);
      }
      return changed;
    });
  }

  update(characterName: string, live2dName: string, patch: CharacterLive2dModelPatch): Promise<CharacterLive2dModel | undefined> {
    return this.mutations.run(characterName, () => {
      const character = this.mutations.requireCharacter(characterName);
      const current = this.find(characterName, live2dName);
      assertResourcePatch(patch);
      const resource = this.updateRecord(characterName, live2dName, patch);
      if (resource) {
        this.mutations.resourcesChanged(characterName);
        if (character.stageKind === 'live2d' && current?.isPrimary) {
          this.mutations.presentationChanged(characterName);
        }
      }
      return resource;
    });
  }

  async prepareImport(
    characterName: string,
    input: PrepareCharacterLive2dImportInput,
  ): Promise<PreparedLive2dImport> {
    return this.mutations.run(characterName, async () => {
      this.mutations.requireCharacter(characterName);
      // Server 能校验本地模型,但封面必须由 Desktop 的 WebGL 生成.这里先只写暂存区,
      // 避免 Desktop 生成 PNG 期间其他窗口看到一个尚未完成的模型.
      const importId = crypto.randomUUID();
      const operationDirectory = this.mutations.paths.stagingOperationDirectory(importId);
      fs.mkdirSync(operationDirectory, { recursive: true });
      const stagedDirectory = path.join(operationDirectory, 'resource');
      try {
        const files = await importLive2dFiles(input.source, stagedDirectory);
        const destination = this.mutations.paths.live2dModelDirectory(characterName, files.name);
        if (fs.existsSync(destination) || this.find(characterName, files.name)) {
          throw new CharacterResourceValidationError('resource_name_conflict');
        }
        const live2dFiles = await findLive2dFiles(stagedDirectory);
        await readLive2dModelResources(live2dFiles.modelPath);
        this.preparedLive2dImports.set(importId, {
          characterName,
          operationDirectory,
          resourceDirectory: stagedDirectory,
          files,
        });
        return { importId, ...files };
      } catch (error) {
        await removeDirectoryIfPresent(operationDirectory);
        throw error;
      }
    });
  }

  streamPreparedArchive(characterName: string, importId: string): Readable {
    const prepared = this.getPreparedImport(characterName, importId);
    return createLive2dArchiveStream(prepared.resourceDirectory);
  }

  async commitImport(
    characterName: string,
    importId: string,
    previewPng: Buffer,
  ): Promise<CharacterLive2dModel> {
    return this.mutations.run(characterName, async () => {
      this.mutations.requireCharacter(characterName);
      const prepared = this.getPreparedImport(characterName, importId);
      const destination = this.mutations.paths.live2dModelDirectory(characterName, prepared.files.name);
      if (fs.existsSync(destination) || this.find(characterName, prepared.files.name)) {
        throw new CharacterResourceValidationError('resource_name_conflict');
      }

      const stagedPreview = path.join(prepared.operationDirectory, 'preview.png');
      const previewTarget = this.mutations.paths.live2dPreviewFile(characterName, prepared.files.name);
      await fs.promises.writeFile(stagedPreview, previewPng);
      await fs.promises.mkdir(this.mutations.paths.live2dRoot(characterName), { recursive: true });
      await fs.promises.mkdir(this.mutations.paths.previewRoot(characterName), { recursive: true });

      // 模型目录和封面都准备好后才写数据库.角色列表以数据库为准,因此其他窗口
      // 不会在封面仍不存在时提前看到这张模型卡片.
      await fs.promises.rename(prepared.resourceDirectory, destination);
      await fs.promises.rename(stagedPreview, previewTarget);
      let resource: CharacterLive2dModel;
      try {
        resource = this.insert(characterName, {
          name: prepared.files.name,
          displayName: prepared.files.displayName,
          isPrimary: false,
          byteSize: prepared.files.byteSize,
        });
      } catch (error) {
        await fs.promises.mkdir(prepared.operationDirectory, { recursive: true });
        await fs.promises.rename(destination, prepared.resourceDirectory);
        await fs.promises.rename(previewTarget, stagedPreview);
        throw error;
      }

      this.preparedLive2dImports.delete(importId);
      await removeDirectoryIfPresent(prepared.operationDirectory);
      this.mutations.resourcesChanged(characterName);
      return resource;
    });
  }

  async cancelImport(characterName: string, importId: string): Promise<void> {
    return this.mutations.run(characterName, async () => {
      const prepared = this.getPreparedImport(characterName, importId);
      await removeDirectoryIfPresent(prepared.operationDirectory);
      this.preparedLive2dImports.delete(importId);
    });
  }

  async export(characterName: string, live2dName: string, destination: string): Promise<string> {
    this.mutations.requireCharacter(characterName);
    const resource = this.find(characterName, live2dName);
    if (!resource) throw new CharacterResourceNotFoundError('live2d_model', live2dName);
    return exportLive2dZip(
      this.mutations.paths.live2dModelDirectory(characterName, live2dName),
      destination,
      resource.displayName,
    );
  }

  async delete(characterName: string, live2dName: string): Promise<CharacterLive2dModel | undefined> {
    return this.mutations.run(characterName, async () => {
      this.mutations.requireCharacter(characterName);
      const current = this.find(characterName, live2dName);
      if (!current) return undefined;
      const operationDirectory = this.mutations.createStagingOperation();
      const source = this.mutations.paths.live2dModelDirectory(characterName, live2dName);
      const staged = await this.mutations.stageExistingPath(source, operationDirectory);
      const previewSource = this.mutations.paths.live2dPreviewFile(characterName, live2dName);
      const previewExists = await fs.promises.stat(previewSource).catch(() => null);
      const stagedPreview = previewExists ? path.join(operationDirectory, 'preview.png') : null;
      if (stagedPreview) await fs.promises.rename(previewSource, stagedPreview);
      try {
        const deleted = this.deleteRecord(characterName, live2dName);
        if (!deleted) {
          if (staged) await fs.promises.rename(staged, source);
          if (stagedPreview) await fs.promises.rename(stagedPreview, previewSource);
        }
        if (deleted) {
          this.mutations.resourcesChanged(characterName);
          if (current.isPrimary) this.mutations.presentationChanged(characterName);
        }
        return deleted;
      } catch (error) {
        if (staged && !fs.existsSync(source)) await fs.promises.rename(staged, source);
        if (stagedPreview && !fs.existsSync(previewSource)) await fs.promises.rename(stagedPreview, previewSource);
        throw error;
      } finally {
        await removeDirectoryIfPresent(operationDirectory);
      }
    });
  }

  resolveDirectory(characterName: string, live2dName: string): string {
    this.mutations.requireCharacter(characterName);
    if (!this.find(characterName, live2dName)) {
      throw new CharacterResourceNotFoundError('live2d_model', live2dName);
    }
    return this.mutations.paths.live2dModelDirectory(characterName, live2dName);
  }

  streamArchive(characterName: string, live2dName: string): Readable {
    const directory = this.resolveDirectory(characterName, live2dName);
    return createLive2dArchiveStream(directory);
  }

  resolvePreviewFile(characterName: string, live2dName: string): string {
    this.mutations.requireCharacter(characterName);
    if (!this.find(characterName, live2dName)) {
      throw new CharacterResourceNotFoundError('live2d_model', live2dName);
    }
    return this.mutations.paths.live2dPreviewFile(characterName, live2dName);
  }

  async savePreview(characterName: string, live2dName: string, png: Buffer): Promise<void> {
    return this.mutations.run(characterName, async () => {
      const target = this.resolvePreviewFile(characterName, live2dName);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, png);
      // 手动重做封面不会改变主舞台,只通知角色资源页面重新读取这张图片.
      this.mutations.resourcesChanged(characterName);
    });
  }

  async reloadConfiguration(characterName: string, live2dName: string): Promise<Live2dConfiguration> {
    return this.mutations.run(characterName, async () => {
      const character = this.mutations.requireCharacter(characterName);
      const configuration = await this.readConfiguration(characterName, live2dName);
      const model = this.find(characterName, live2dName);
      if (character.stageKind === 'live2d' && model?.isPrimary) {
        this.mutations.presentationChanged(characterName);
      }
      return configuration;
    });
  }

  async readConfiguration(characterName: string, live2dName: string): Promise<Live2dConfiguration> {
    this.mutations.requireCharacter(characterName);
    const model = this.find(characterName, live2dName);
    if (!model) {
      throw new CharacterResourceNotFoundError('live2d_model', live2dName);
    }
    const directory = this.mutations.paths.live2dModelDirectory(characterName, live2dName);
    const files = await findLive2dFiles(directory);
    const resources = await readLive2dModelResources(files.modelPath);
    return {
      mappings: { emotionMap: model.emotionMap, motionMap: model.motionMap },
      expressions: resources.expressions.map(expression => ({
        expression: expression.name,
        file: expression.file,
      })),
      motions: resources.motions,
      unregisteredExpressionFiles: resources.unregisteredExpressionFiles,
      unregisteredMotionFiles: resources.unregisteredMotionFiles,
    };
  }

  async saveMappings(characterName: string, live2dName: string, mappings: Live2dMappings): Promise<Live2dConfiguration> {
    return this.mutations.run(characterName, async () => {
      const character = this.mutations.requireCharacter(characterName);
      const model = this.find(characterName, live2dName);
      if (!model) {
        throw new CharacterResourceNotFoundError('live2d_model', live2dName);
      }
      const directory = this.mutations.paths.live2dModelDirectory(characterName, live2dName);
      const files = await findLive2dFiles(directory);
      const resources = await readLive2dModelResources(files.modelPath);
      assertLive2dMappings(
        mappings,
        resources.expressions.map(expression => expression.name),
        resources.motions,
      );
      this.updateMappingsRecord(characterName, live2dName, mappings);
      this.mutations.resourcesChanged(characterName);
      if (character.stageKind === 'live2d' && model.isPrimary) {
        this.mutations.presentationChanged(characterName);
      }
      return {
        mappings,
        expressions: resources.expressions.map(expression => ({
          expression: expression.name,
          file: expression.file,
        })),
        motions: resources.motions,
        unregisteredExpressionFiles: resources.unregisteredExpressionFiles,
        unregisteredMotionFiles: resources.unregisteredMotionFiles,
      };
    });
  }

  backfillByteSizes(characterNames: readonly string[]): void {
    for (const characterName of characterNames) {
      for (const model of this.list(characterName)) {
        if (model.byteSize !== null) continue;
        const directory = this.mutations.paths.live2dModelDirectory(characterName, model.name);
        const stat = fs.statSync(directory, { throwIfNoEntry: false });
        if (stat?.isDirectory()) {
          this.updateByteSize(characterName, model.name, live2dDirectoryByteSizeSync(directory));
        }
      }
    }
  }

  private getPreparedImport(
    characterName: string,
    importId: string,
  ): PreparedLive2dImportEntry {
    const prepared = this.preparedLive2dImports.get(importId);
    if (!prepared || prepared.characterName !== characterName) {
      throw new CharacterResourceNotFoundError('live2d_import', importId);
    }
    return prepared;
  }

  presentation(characterName: string): CharacterStagePresentation {
      const resource = this.findPrimary(characterName);
      if (!resource) {
        return { status: 'unavailable', characterName, stageKind: 'live2d', reason: 'primary_resource_missing' };
      }
      try {
        const directory = this.mutations.paths.live2dModelDirectory(characterName, resource.name);
        findLive2dFilesSync(directory);
        return {
          status: 'live2d',
          characterName,
          resource: {
            kind: 'live2d',
            name: resource.name,
            displayName: resource.displayName,
            stageScale: resource.stageScale,
            stageOffsetX: resource.stageOffsetX,
            stageOffsetY: resource.stageOffsetY,
            emotionMap: resource.emotionMap,
            motionMap: resource.motionMap,
          },
        };
      } catch {
        return {
          status: 'unavailable',
          characterName,
          stageKind: 'live2d',
          reason: fs.existsSync(this.mutations.paths.live2dModelDirectory(characterName, resource.name)) ? 'resource_invalid' : 'resource_file_missing',
        };
      }

  }
}
