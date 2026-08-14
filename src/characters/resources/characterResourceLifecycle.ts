// 导入、导出和删除角色的 Live2D、立绘与参考音频文件。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  asCharacterIllustrationId,
  asCharacterLive2dId,
  asCharacterVoiceReferenceId,
  type CharacterCardId,
  type CharacterIllustrationId,
  type CharacterLive2dId,
  type CharacterVoiceReferenceId,
} from '@ema-agent/ids';
import type { CharacterCard } from '../types.js';
import type {
  CharacterLive2dVariant,
  CharacterLive2dVariantInput,
  ImportCharacterLive2dInput,
} from '../live2d/types.js';
import { CharacterLive2dRepository } from '../live2d/repository.js';
import { findLive2dPackageFiles } from '../live2d/live2dValidator.js';
import type {
  CharacterIllustration,
  ImportCharacterIllustrationInput,
} from '../illustration/types.js';
import { CharacterIllustrationRepository } from '../illustration/repository.js';
import type {
  CharacterVoiceReference,
  CharacterVoiceReferenceInput,
  ImportCharacterVoiceReferenceInput,
} from '../voice/types.js';
import { CharacterVoiceReferenceRepository } from '../voice/repository.js';
import { validateVoiceReferenceFile } from '../voice/voiceReferenceValidator.js';
import { CharacterResourcePaths } from './characterResourcePaths.js';
import {
  copyCharacterDirectory,
  copyCharacterFile,
  exportCharacterResource,
} from './characterResourceTransfer.js';
import { CHARACTER_RESOURCE_LIMITS } from './characterResourceLimits.js';

export class CharacterResourceLifecycle {
  constructor(
    private readonly getCard: (id: CharacterCardId) => CharacterCard | undefined,
    private readonly live2d: CharacterLive2dRepository,
    private readonly illustrations: CharacterIllustrationRepository,
    private readonly voiceReferences: CharacterVoiceReferenceRepository,
    private readonly paths: CharacterResourcePaths,
    private readonly insertLive2d: (
      id: CharacterCardId,
      input: CharacterLive2dVariantInput & { id: CharacterLive2dId },
    ) => CharacterLive2dVariant,
    private readonly deleteLive2dRecord: (
      id: CharacterCardId,
      resourceId: CharacterLive2dId,
    ) => CharacterLive2dVariant | undefined,
    private readonly presentationChanged: (id: CharacterCardId) => void,
  ) {}

  async importLive2d(
    id: CharacterCardId,
    input: ImportCharacterLive2dInput,
  ): Promise<CharacterLive2dVariant> {
    const card = this.assertMutableCard(id);
    await findLive2dPackageFiles(input.sourceDirectory);
    const resourceId = asCharacterLive2dId(randomUUID());
    const destination = this.paths.live2dDirectory(id, resourceId);
    const byteSize = await copyCharacterDirectory(input.sourceDirectory, destination);
    await findLive2dPackageFiles(destination);
    const resource = this.insertLive2d(id, {
      id: resourceId,
      name: input.name,
      isPrimary: input.isPrimary ?? card.live2dVariants.length === 0,
      byteSize,
    });
    this.presentationChanged(id);
    return resource;
  }

  async exportLive2d(
    id: CharacterCardId,
    resourceId: CharacterLive2dId,
    destinationDirectory: string,
  ): Promise<string> {
    const card = this.getRequiredCard(id);
    const resource = card.live2dVariants.find(item => item.id === resourceId);
    if (!resource) throw new Error(`Live2D resource not found: ${resourceId}`);
    return exportCharacterResource(
      this.paths.live2dDirectory(id, resourceId),
      destinationDirectory,
      resource.name,
    );
  }

  async deleteLive2d(
    id: CharacterCardId,
    resourceId: CharacterLive2dId,
  ): Promise<CharacterLive2dVariant | undefined> {
    this.assertMutableCard(id);
    const current = this.live2d.list(id).find(item => item.id === resourceId);
    if (!current) return undefined;
    await fs.promises.rm(this.paths.live2dDirectory(id, resourceId), { recursive: true });
    const deleted = this.deleteLive2dRecord(id, resourceId);
    if (deleted) this.presentationChanged(id);
    return deleted;
  }

  async importIllustration(
    id: CharacterCardId,
    input: ImportCharacterIllustrationInput,
  ): Promise<CharacterIllustration> {
    const card = this.assertMutableCard(id);
    const resourceId = asCharacterIllustrationId(randomUUID());
    const destination = this.paths.illustrationImportPath(
      id,
      resourceId,
      path.extname(input.sourceFile),
    );
    const byteSize = await copyCharacterFile(
      input.sourceFile,
      destination,
      CHARACTER_RESOURCE_LIMITS.illustrationBytes,
    );
    const resource = this.illustrations.insert(id, {
      id: resourceId,
      name: input.name,
      isPrimary: input.isPrimary ?? card.illustrations.length === 0,
      byteSize,
    });
    this.presentationChanged(id);
    return resource;
  }

  async exportIllustration(
    id: CharacterCardId,
    resourceId: CharacterIllustrationId,
    destinationDirectory: string,
  ): Promise<string> {
    const card = this.getRequiredCard(id);
    const resource = card.illustrations.find(item => item.id === resourceId);
    if (!resource) throw new Error(`illustration resource not found: ${resourceId}`);
    return exportCharacterResource(
      this.paths.illustrationFile(id, resourceId),
      destinationDirectory,
      resource.name,
    );
  }

  async deleteIllustration(
    id: CharacterCardId,
    resourceId: CharacterIllustrationId,
  ): Promise<CharacterIllustration | undefined> {
    this.assertMutableCard(id);
    const current = this.illustrations.list(id).find(item => item.id === resourceId);
    if (!current) return undefined;
    await fs.promises.rm(this.paths.illustrationFile(id, resourceId));
    const deleted = this.illustrations.delete(id, resourceId);
    if (deleted) this.presentationChanged(id);
    return deleted;
  }

  async publishVoice(
    id: CharacterCardId,
    input: CharacterVoiceReferenceInput & { id: CharacterVoiceReferenceId },
    bytes: Uint8Array,
    extension: string,
  ): Promise<CharacterVoiceReference> {
    this.assertMutableCard(id);
    const destination = this.paths.voiceImportPath(id, input.id, extension);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.writeFile(destination, bytes, { flag: 'wx' });
    try {
      const validated = await validateVoiceReferenceFile(destination);
      return this.voiceReferences.insert(id, {
        ...input,
        mimeType: validated.mimeType,
        byteSize: validated.byteSize,
        durationMs: validated.durationMs,
      });
    } catch (error) {
      await fs.promises.rm(destination, { force: true });
      throw error;
    }
  }

  async importVoice(
    id: CharacterCardId,
    input: ImportCharacterVoiceReferenceInput,
  ): Promise<CharacterVoiceReference> {
    const card = this.assertMutableCard(id);
    const validated = await validateVoiceReferenceFile(input.sourceFile);
    const resourceId = asCharacterVoiceReferenceId(randomUUID());
    await copyCharacterFile(
      input.sourceFile,
      this.paths.voiceImportPath(id, resourceId, `.${validated.extension}`),
      CHARACTER_RESOURCE_LIMITS.voiceBytes,
    );
    return this.voiceReferences.insert(id, {
      id: resourceId,
      name: input.name,
      promptText: input.promptText,
      promptLang: input.promptLang,
      isPrimary: input.isPrimary ?? card.voiceReferences.length === 0,
      mimeType: validated.mimeType,
      byteSize: validated.byteSize,
      durationMs: validated.durationMs,
    });
  }

  async exportVoice(
    id: CharacterCardId,
    resourceId: CharacterVoiceReferenceId,
    destinationDirectory: string,
  ): Promise<string> {
    const card = this.getRequiredCard(id);
    const resource = card.voiceReferences.find(item => item.id === resourceId);
    if (!resource) throw new Error(`voice reference not found: ${resourceId}`);
    return exportCharacterResource(
      this.paths.voiceFile(id, resourceId),
      destinationDirectory,
      resource.name,
    );
  }

  async deleteVoice(
    id: CharacterCardId,
    resourceId: CharacterVoiceReferenceId,
  ): Promise<CharacterVoiceReference | undefined> {
    this.assertMutableCard(id);
    const current = this.voiceReferences.list(id).find(item => item.id === resourceId);
    if (!current) return undefined;
    await fs.promises.rm(this.paths.voiceFile(id, resourceId));
    return this.voiceReferences.delete(id, resourceId);
  }

  private getRequiredCard(id: CharacterCardId): CharacterCard {
    const card = this.getCard(id);
    if (!card) throw new Error(`character card not found: ${id}`);
    return card;
  }

  private assertMutableCard(id: CharacterCardId): CharacterCard {
    const card = this.getRequiredCard(id);
    if (card.isBuiltin) throw new Error(`builtin character is read-only: ${id}`);
    return card;
  }
}
