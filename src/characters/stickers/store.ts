import fs from 'node:fs/promises';
import path from 'node:path';
import { CharacterStickerRepo, type CharacterStickerRow } from '@ema-agent/storage';
import { CharacterMutations } from '../resources/characterMutations.js';
import { exportResourceFile, removeDirectoryIfPresent } from '../resources/resourceFiles.js';
import { importImageFile } from '../resources/imageFiles.js';
import {
  CharacterInputInvalidError,
  CharacterPromptInvalidError,
  CharacterResourceNotFoundError,
  CharacterResourceValidationError,
} from '../errors.js';
import type { CharacterSticker, CharacterStickerPatch } from './types.js';
import { buildStickerPrompt } from './stickerPrompt.js';
import { CHARACTER_STICKER_PROMPT_MAX_CHARS } from './limits.js';

function fromRow(row: CharacterStickerRow): CharacterSticker {
  return {
    name: row.name,
    characterName: row.character_name,
    displayName: row.display_name,
    description: row.description,
    byteSize: row.byte_size,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CharacterStickerStore {
  constructor(
    private readonly repo: CharacterStickerRepo,
    private readonly mutations: CharacterMutations,
  ) {}

  list(characterName: string): CharacterSticker[] {
    return this.repo.list(characterName).map(fromRow);
  }

  listForCharacters(names: readonly string[]): Map<string, CharacterSticker[]> {
    const grouped = new Map<string, CharacterSticker[]>();
    for (const row of this.repo.listForCharacters(names)) {
      const items = grouped.get(row.character_name) ?? [];
      items.push(fromRow(row));
      grouped.set(row.character_name, items);
    }
    return grouped;
  }

  // 角色列表已经读过图片时复用这些记录, 避免为了显示字数再次查询 SQL.
  prompt(characterName: string, items = this.list(characterName)): string {
    return this.buildPrompt(characterName, items);
  }

  private buildPrompt(characterName: string, items: readonly CharacterSticker[]): string {
    return buildStickerPrompt(items, name => this.mutations.paths.stickerFile(characterName, name));
  }

  resolveFile(characterName: string, name: string): string {
    this.mutations.requireCharacter(characterName);
    if (!this.repo.find(characterName, name)) throw new CharacterResourceNotFoundError('sticker', name);
    return this.mutations.paths.stickerFile(characterName, name);
  }

  import(characterName: string, sourceFile: string): Promise<CharacterSticker> {
    return this.mutations.run(characterName, async () => {
      this.mutations.requireCharacter(characterName);
      const staging = this.mutations.createStagingOperation();
      try {
        const stagedFile = path.join(staging, 'resource');
        const file = await importImageFile(sourceFile, stagedFile);
        if (this.repo.find(characterName, file.name)) throw new CharacterResourceValidationError('resource_name_conflict');
        const destination = this.mutations.paths.stickerFile(characterName, file.name);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        // 独占创建目标, 同名文件不覆盖. SQL 失败只删除本次刚创建的文件.
        await fs.copyFile(stagedFile, destination, fs.constants.COPYFILE_EXCL);
        const now = Date.now();
        const row: CharacterStickerRow = {
          character_name: characterName,
          name: file.name,
          display_name: file.displayName,
          description: '',
          byte_size: file.byteSize,
          created_at: now,
          updated_at: now,
        };
        try {
          this.repo.insert(row);
        } catch (error) {
          await fs.rm(destination);
          throw error;
        }
        this.mutations.resourcesChanged(characterName);
        return fromRow(row);
      } finally {
        await removeDirectoryIfPresent(staging);
      }
    });
  }

  update(characterName: string, name: string, patch: CharacterStickerPatch): Promise<CharacterSticker> {
    return this.mutations.run(characterName, () => {
      this.resolveFile(characterName, name);
      const displayName = patch.displayName.trim();
      const description = patch.description.trim();
      if (!displayName) throw new CharacterInputInvalidError('resource_name_empty');
      const items = this.list(characterName).map(item => item.name === name ? { ...item, displayName, description } : item);
      const length = this.buildPrompt(characterName, items).length;
      if (length > CHARACTER_STICKER_PROMPT_MAX_CHARS) {
        throw new CharacterPromptInvalidError(
          `表情包说明共 ${length} 字符, 超过上限 ${CHARACTER_STICKER_PROMPT_MAX_CHARS}, 请缩短 ${length - CHARACTER_STICKER_PROMPT_MAX_CHARS} 字符`,
          characterName,
        );
      }
      this.repo.update(characterName, name, displayName, description, Date.now());
      this.mutations.resourcesChanged(characterName);
      return fromRow(this.repo.find(characterName, name)!);
    });
  }

  export(characterName: string, name: string, destination: string): Promise<string> {
    const file = this.resolveFile(characterName, name);
    return exportResourceFile(file, destination, this.repo.find(characterName, name)!.display_name);
  }

  delete(characterName: string, name: string): Promise<void> {
    return this.mutations.run(characterName, async () => {
      const source = this.resolveFile(characterName, name);
      const staging = this.mutations.createStagingOperation();
      const staged = await this.mutations.stageExistingPath(source, staging);
      try {
        this.repo.delete(characterName, name);
      } catch (error) {
        if (staged) await fs.rename(staged, source);
        throw error;
      } finally {
        await removeDirectoryIfPresent(staging);
      }
      this.mutations.resourcesChanged(characterName);
    });
  }
}
