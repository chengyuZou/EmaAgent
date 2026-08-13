// 统一执行三类角色资源的深检、原子导入导出和可恢复删除。

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  asCharacterLive2dId,
  asCharacterPortraitId,
  asCharacterVoiceReferenceId,
  type CharacterCardId,
  type CharacterLive2dId,
  type CharacterPortraitId,
  type CharacterVoiceReferenceId,
} from '@ema-agent/ids';
import type { CharacterCard } from '../types.js';
import type {
  CharacterLive2dVariant,
  CharacterLive2dVariantInput,
  ImportCharacterLive2dInput,
} from '../live2d/types.js';
import { CharacterLive2dRepository } from '../live2d/repository.js';
import {
  copyAndValidateLive2dDirectory,
} from '../live2d/live2dValidator.js';
import type {
  CharacterPortrait,
  ImportCharacterPortraitInput,
} from '../portraits/types.js';
import { CharacterPortraitRepository } from '../portraits/repository.js';
import { normalizePortrait } from '../portraits/portraitNormalizer.js';
import type {
  CharacterVoiceReference,
  CharacterVoiceReferenceInput,
  ImportCharacterVoiceReferenceInput,
} from '../voiceReferences/types.js';
import { CharacterVoiceReferenceRepository } from '../voiceReferences/repository.js';
import {
  validateVoiceReferenceFile,
} from '../voiceReferences/voiceReferenceValidator.js';
import { CharacterResourcePaths } from './characterResourcePaths.js';
import { CharacterResourceOperations } from './characterResourceOperations.js';
import { CharacterResourceTrash } from './characterResourceTrash.js';
import { CharacterResourceStaging } from '../transfer/staging.js';
import {
  copyFileBounded,
  exportPathAtomically,
} from './characterResourceTransfer.js';
import { CHARACTER_RESOURCE_LIMITS } from './characterResourceLimits.js';

export class CharacterResourceLifecycle {
  constructor(
    private readonly getCard: (id: CharacterCardId) => CharacterCard | undefined,
    private readonly live2d: CharacterLive2dRepository,
    private readonly portraits: CharacterPortraitRepository,
    private readonly voiceReferences: CharacterVoiceReferenceRepository,
    private readonly paths: CharacterResourcePaths,
    private readonly trash: CharacterResourceTrash,
    private readonly staging: CharacterResourceStaging,
    private readonly operations: CharacterResourceOperations,
    private readonly insertLive2d: (
      id: CharacterCardId,
      input: CharacterLive2dVariantInput,
    ) => CharacterLive2dVariant,
    private readonly deleteLive2dRecord: (
      id: CharacterCardId,
      resourceId: CharacterLive2dId,
    ) => CharacterLive2dVariant | undefined,
    private readonly presentationChanged: (id: CharacterCardId) => void,
  ) {}

  importLive2d(
    id: CharacterCardId,
    input: ImportCharacterLive2dInput,
  ): Promise<CharacterLive2dVariant> {
    const resourceId = asCharacterLive2dId(randomUUID());
    const packageRelativePath = `live2d/${resourceId}`;
    const entryPath = `${packageRelativePath}/${input.entryRelativePath}`;
    const runtimeConfigPath = input.runtimeConfigRelativePath
      ? `${packageRelativePath}/${input.runtimeConfigRelativePath}`
      : null;
    return this.operations.run(id, 'resourceImport', async ({ setStage }) => {
      const card = this.assertMutableCard(id);
      setStage('validating');
      this.paths.resolve(id, false, entryPath, 'live2d');
      if (runtimeConfigPath) this.paths.resolve(id, false, runtimeConfigPath, 'live2d');
      setStage('staging');
      const resource = await this.staging.publishPrepared({
        characterId: id,
        resourceKind: 'live2d',
        resourceId,
        relativePath: entryPath,
        targetRelativePath: packageRelativePath,
        prepare: payload => copyAndValidateLive2dDirectory({
          sourceDirectory: input.sourceDirectory,
          destinationDirectory: payload,
          format: input.format,
          entryRelativePath: input.entryRelativePath,
          runtimeConfigRelativePath: input.runtimeConfigRelativePath,
        }),
        commit: prepared => {
          setStage('publishing');
          const inserted = this.insertLive2d(id, {
            id: resourceId,
            label: input.label,
            format: input.format,
            entryPath,
            runtimeConfigPath,
            position: input.position,
            isPrimary: input.isPrimary ?? card.live2dVariants.length === 0,
            byteSize: prepared.byteSize,
          });
          this.presentationChanged(id);
          return inserted;
        },
        isReferenced: () => this.live2d.list(id).some(
          item => item.id === resourceId && item.entryPath === entryPath,
        ),
      });
      setStage('finalizing');
      return resource;
    });
  }

  exportLive2d(
    id: CharacterCardId,
    resourceId: CharacterLive2dId,
    destinationDirectory: string,
  ): Promise<string> {
    return this.operations.run(id, 'resourceExport', async ({ setStage }) => {
      const card = this.assertMutableCard(id);
      const resource = card.live2dVariants.find(item => item.id === resourceId);
      if (!resource) throw new Error(`Live2D resource not found: ${resourceId}`);
      const packageRelativePath = live2dPackagePath(resource);
      setStage('validating');
      const source = this.paths.resolve(id, false, packageRelativePath, 'live2d');
      setStage('publishing');
      const exported = await exportPathAtomically(
        source,
        destinationDirectory,
        String(resource.id),
        live2dExportLimits(),
      );
      setStage('finalizing');
      return exported;
    });
  }

  deleteLive2d(
    id: CharacterCardId,
    resourceId: CharacterLive2dId,
  ): Promise<CharacterLive2dVariant | undefined> {
    return this.operations.run(id, 'resourceDelete', async ({ setStage }) => {
      this.assertMutableCard(id);
      setStage('validating');
      const current = this.live2d.list(id).find(item => item.id === resourceId);
      if (!current) return undefined;
      setStage('staging');
      const deleted = this.trash.delete({
        characterId: id,
        resourceKind: 'live2d',
        resourceId,
        relativePath: current.entryPath,
        targetRelativePath: live2dPackagePath(current),
        commit: () => {
          setStage('publishing');
          const result = this.deleteLive2dRecord(id, resourceId);
          if (!result) throw new Error(`Live2D resource disappeared: ${resourceId}`);
          this.presentationChanged(id);
          return result;
        },
        isReferenced: () => this.live2d.list(id).some(item => item.id === resourceId),
      });
      setStage('finalizing');
      return deleted;
    });
  }

  importPortrait(
    id: CharacterCardId,
    input: ImportCharacterPortraitInput,
  ): Promise<CharacterPortrait> {
    const resourceId = asCharacterPortraitId(randomUUID());
    const relativePath = `portraits/${resourceId}`;
    return this.operations.run(id, 'resourceImport', async ({ setStage }) => {
      const card = this.assertMutableCard(id);
      setStage('validating');
      this.paths.resolve(id, false, relativePath, 'portrait');
      setStage('staging');
      const resource = await this.staging.publishPrepared({
        characterId: id,
        resourceKind: 'portrait',
        resourceId,
        relativePath,
        prepare: payload => normalizePortrait(input.sourceFile, payload),
        commit: prepared => {
          setStage('publishing');
          const inserted = this.portraits.insert(id, {
            id: resourceId,
            label: input.label,
            relativePath,
            position: input.position,
            isPrimary: input.isPrimary ?? card.portraits.length === 0,
            mimeType: prepared.mimeType,
            byteSize: prepared.byteSize,
            width: prepared.width,
            height: prepared.height,
          });
          this.presentationChanged(id);
          return inserted;
        },
        isReferenced: () => this.portraits.list(id).some(
          item => item.id === resourceId && item.relativePath === relativePath,
        ),
      });
      setStage('finalizing');
      return resource;
    });
  }

  exportPortrait(
    id: CharacterCardId,
    resourceId: CharacterPortraitId,
    destinationDirectory: string,
  ): Promise<string> {
    return this.operations.run(id, 'resourceExport', async ({ setStage }) => {
      const card = this.assertMutableCard(id);
      const resource = card.portraits.find(item => item.id === resourceId);
      if (!resource) throw new Error(`portrait resource not found: ${resourceId}`);
      setStage('validating');
      const source = this.paths.resolve(id, false, resource.relativePath, 'portrait');
      setStage('publishing');
      const exported = await exportPathAtomically(
        source,
        destinationDirectory,
        `${resource.id}.${portraitExtension(resource.mimeType)}`,
        singleFileExportLimits(CHARACTER_RESOURCE_LIMITS.portraitOutputBytes),
      );
      setStage('finalizing');
      return exported;
    });
  }

  deletePortrait(
    id: CharacterCardId,
    resourceId: CharacterPortraitId,
  ): Promise<CharacterPortrait | undefined> {
    return this.operations.run(id, 'resourceDelete', async ({ setStage }) => {
      this.assertMutableCard(id);
      setStage('validating');
      const current = this.portraits.list(id).find(item => item.id === resourceId);
      if (!current) return undefined;
      setStage('staging');
      const deleted = this.trash.delete({
        characterId: id,
        resourceKind: 'portrait',
        resourceId,
        relativePath: current.relativePath,
        commit: () => {
          setStage('publishing');
          const result = this.portraits.delete(id, resourceId);
          if (!result) throw new Error(`portrait resource disappeared: ${resourceId}`);
          this.presentationChanged(id);
          return result;
        },
        isReferenced: () => this.portraits.list(id).some(item => item.id === resourceId),
      });
      setStage('finalizing');
      return deleted;
    });
  }

  publishVoice(
    id: CharacterCardId,
    input: CharacterVoiceReferenceInput & { id: CharacterVoiceReferenceId },
    bytes: Uint8Array,
  ): Promise<CharacterVoiceReference> {
    return this.operations.run(id, 'voiceReferenceUpload', async ({ setStage }) => {
      this.assertMutableCard(id);
      setStage('validating');
      this.paths.resolve(id, false, input.relativePath, 'voiceReference');
      setStage('staging');
      const published = await this.staging.publishPrepared({
        characterId: id,
        resourceKind: 'voiceReference',
        resourceId: input.id,
        relativePath: input.relativePath,
        prepare: async payload => {
          await fs.promises.writeFile(payload, bytes, { flag: 'wx' });
          return validateVoiceReferenceFile(payload);
        },
        commit: prepared => {
          setStage('publishing');
          return this.voiceReferences.insert(id, {
            ...input,
            mimeType: prepared.mimeType,
            byteSize: prepared.byteSize,
            durationMs: prepared.durationMs,
          });
        },
        isReferenced: () => this.voiceReferences.list(id).some(
          item => item.id === input.id && item.relativePath === input.relativePath,
        ),
      });
      setStage('finalizing');
      return published;
    });
  }

  importVoice(
    id: CharacterCardId,
    input: ImportCharacterVoiceReferenceInput,
  ): Promise<CharacterVoiceReference> {
    const resourceId = asCharacterVoiceReferenceId(randomUUID());
    const relativePath = `voiceRefs/${resourceId}`;
    return this.operations.run(id, 'resourceImport', async ({ setStage }) => {
      const card = this.assertMutableCard(id);
      setStage('validating');
      this.paths.resolve(id, false, relativePath, 'voiceReference');
      setStage('staging');
      const resource = await this.staging.publishPrepared({
        characterId: id,
        resourceKind: 'voiceReference',
        resourceId,
        relativePath,
        prepare: async payload => {
          await copyFileBounded(
            input.sourceFile,
            payload,
            CHARACTER_RESOURCE_LIMITS.voiceBytes,
          );
          return validateVoiceReferenceFile(payload);
        },
        commit: prepared => {
          setStage('publishing');
          return this.voiceReferences.insert(id, {
            id: resourceId,
            label: input.label,
            relativePath,
            promptText: input.promptText,
            promptLang: input.promptLang,
            position: input.position,
            isPrimary: input.isPrimary ?? card.voiceReferences.length === 0,
            mimeType: prepared.mimeType,
            byteSize: prepared.byteSize,
            durationMs: prepared.durationMs,
          });
        },
        isReferenced: () => this.voiceReferences.list(id).some(
          item => item.id === resourceId && item.relativePath === relativePath,
        ),
      });
      setStage('finalizing');
      return resource;
    });
  }

  exportVoice(
    id: CharacterCardId,
    resourceId: CharacterVoiceReferenceId,
    destinationDirectory: string,
  ): Promise<string> {
    return this.operations.run(id, 'resourceExport', async ({ setStage }) => {
      const card = this.assertMutableCard(id);
      const resource = card.voiceReferences.find(item => item.id === resourceId);
      if (!resource) throw new Error(`voice reference not found: ${resourceId}`);
      setStage('validating');
      const source = this.paths.resolve(id, false, resource.relativePath, 'voiceReference');
      setStage('publishing');
      const exported = await exportPathAtomically(
        source,
        destinationDirectory,
        `${resource.id}.${voiceExtension(resource.mimeType)}`,
        singleFileExportLimits(CHARACTER_RESOURCE_LIMITS.voiceBytes),
      );
      setStage('finalizing');
      return exported;
    });
  }

  deleteVoice(
    id: CharacterCardId,
    resourceId: CharacterVoiceReferenceId,
  ): Promise<CharacterVoiceReference | undefined> {
    return this.operations.run(id, 'voiceReferenceDelete', async ({ setStage }) => {
      this.assertMutableCard(id);
      setStage('validating');
      const current = this.voiceReferences.list(id).find(item => item.id === resourceId);
      if (!current) return undefined;
      setStage('staging');
      const deleted = this.trash.delete({
        characterId: id,
        resourceKind: 'voiceReference',
        resourceId,
        relativePath: current.relativePath,
        commit: () => {
          setStage('publishing');
          const result = this.voiceReferences.delete(id, resourceId);
          if (!result) throw new Error(`voice reference disappeared: ${resourceId}`);
          return result;
        },
        isReferenced: () => this.voiceReferences.list(id).some(
          item => item.id === resourceId && item.relativePath === current.relativePath,
        ),
      });
      setStage('finalizing');
      return deleted;
    });
  }

  private assertMutableCard(id: CharacterCardId): CharacterCard {
    const card = this.getCard(id);
    if (!card) throw new Error(`character card not found: ${id}`);
    if (card.isBuiltin) throw new Error(`builtin character is read-only: ${id}`);
    return card;
  }
}

function live2dPackagePath(resource: CharacterLive2dVariant): string {
  const expected = `live2d/${resource.id}/`;
  if (!resource.entryPath.startsWith(expected)) {
    throw new Error(`Live2D resource is not managed by C3b: ${resource.id}`);
  }
  return expected.slice(0, -1);
}

function live2dExportLimits() {
  return {
    maxFiles: CHARACTER_RESOURCE_LIMITS.live2dFiles,
    maxSingleFileBytes: CHARACTER_RESOURCE_LIMITS.live2dSingleFileBytes,
    maxTotalBytes: CHARACTER_RESOURCE_LIMITS.live2dTotalBytes,
    maxFileBytes: CHARACTER_RESOURCE_LIMITS.live2dSingleFileBytes,
  };
}

function singleFileExportLimits(maxBytes: number) {
  return {
    maxFiles: 1,
    maxSingleFileBytes: maxBytes,
    maxTotalBytes: maxBytes,
    maxFileBytes: maxBytes,
  };
}

function portraitExtension(mimeType: CharacterPortrait['mimeType']): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}

function voiceExtension(mimeType: string): string {
  if (mimeType === 'audio/mpeg') return 'mp3';
  if (mimeType === 'audio/flac') return 'flac';
  if (mimeType === 'audio/ogg') return 'ogg';
  if (mimeType === 'audio/mp4') return 'm4a';
  return 'wav';
}
