import { CharacterVoiceSampleRepo, type CharacterVoiceSampleRow } from '@ema-agent/storage';
import fs from 'node:fs';
import path from 'node:path';
import { CharacterMutations, assertResourcePatch } from '../resources/characterMutations.js';
import { removeDirectoryIfPresent, removeFileIfPresent } from '../resources/resourceFiles.js';
import {
  CharacterResourceNotFoundError,
  CharacterResourceValidationError,
  CharacterInputInvalidError,
} from '../errors.js';
import type {
  CharacterVoiceSample,
  CharacterVoiceSampleInput,
  CharacterVoiceSamplePatch,
  ImportCharacterVoiceSampleInput,
} from './types.js';
import { validateVoiceSampleFile } from './voiceSampleValidator.js';
import { exportVoiceFile, importVoiceFile } from './voiceFiles.js';


function fromRow(row: CharacterVoiceSampleRow): CharacterVoiceSample {
  return {
    name: row.name,
    characterName: row.character_name,
    displayName: row.display_name,
    promptText: row.prompt_text,
    promptLang: row.prompt_lang,
    isPrimary: row.is_primary === 1,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CharacterVoiceSampleStore {
  constructor(
    private readonly repo: CharacterVoiceSampleRepo,
    private readonly mutations: CharacterMutations,
  ) {}

  list(characterName: string): CharacterVoiceSample[] {
    return this.repo.listForCharacter(characterName).map(fromRow);
  }

  find(characterName: string, name: string): CharacterVoiceSample | undefined {
    const row = this.repo.find(characterName, name);
    return row ? fromRow(row) : undefined;
  }

  findPrimary(characterName: string): CharacterVoiceSample | undefined {
    const row = this.repo.findPrimary(characterName);
    return row ? fromRow(row) : undefined;
  }

  listForCharacters(characterNames: readonly string[]): Map<string, CharacterVoiceSample[]> {
    const grouped = new Map<string, CharacterVoiceSample[]>();
    for (const row of this.repo.listForCharacters(characterNames)) {
      const list = grouped.get(row.character_name) ?? [];
      list.push(fromRow(row));
      grouped.set(row.character_name, list);
    }
    return grouped;
  }

  insert(characterName: string, input: CharacterVoiceSampleInput): CharacterVoiceSample {
    const now = Date.now();
    this.repo.insert({ ...input, characterName, createdAt: now, updatedAt: now });
    return fromRow(this.repo.find(characterName, input.name)!);
  }

  private setPrimaryRecord(characterName: string, name: string): boolean {
    return this.repo.setPrimary(characterName, name, Date.now());
  }

  private updateRecord(characterName: string, name: string, patch: CharacterVoiceSamplePatch): CharacterVoiceSample | undefined {
    const row = this.repo.update(characterName, name, patch, Date.now());
    return row ? fromRow(row) : undefined;
  }

  private deleteRecord(characterName: string, name: string): CharacterVoiceSample | undefined {
    const row = this.repo.delete(characterName, name);
    return row ? fromRow(row) : undefined;
  }

  setPrimary(characterName: string, voiceName: string): Promise<boolean> {
    return this.mutations.run(characterName, () => {
      this.mutations.requireCharacter(characterName);
      if (!this.find(characterName, voiceName)) {
        throw new CharacterResourceNotFoundError('voice_sample', voiceName);
      }
      const changed = this.setPrimaryRecord(characterName, voiceName);
      if (changed) this.mutations.resourcesChanged(characterName);
      return changed;
    });
  }

  update(characterName: string, voiceName: string, patch: CharacterVoiceSamplePatch): Promise<CharacterVoiceSample | undefined> {
    return this.mutations.run(characterName, () => {
      this.mutations.requireCharacter(characterName);
      const normalized: CharacterVoiceSamplePatch = {
        ...(patch.displayName !== undefined ? { displayName: patch.displayName.trim() } : {}),
        ...(patch.promptText !== undefined ? { promptText: patch.promptText.trim() } : {}),
        ...(patch.promptLang !== undefined ? { promptLang: patch.promptLang.trim() } : {}),
      };
      assertResourcePatch(normalized);
      if (
        normalized.promptText === ''
        || normalized.promptLang === ''
      ) {
        throw new CharacterInputInvalidError('voice_prompt_required', characterName);
      }
      const resource = this.updateRecord(characterName, voiceName, normalized);
      if (resource) this.mutations.resourcesChanged(characterName);
      return resource;
    });
  }

  async import(characterName: string, input: ImportCharacterVoiceSampleInput): Promise<CharacterVoiceSample> {
    return this.mutations.run(characterName, async () => {
      this.mutations.requireCharacter(characterName);
      const promptText = input.promptText.trim();
      const promptLang = input.promptLang.trim();
      if (!promptText || !promptLang) {
        throw new CharacterInputInvalidError('voice_prompt_required', characterName);
      }
      const validated = await validateVoiceSampleFile(input.sourceFile);
      const operationDirectory = this.mutations.createStagingOperation();
      const stagedFile = path.join(operationDirectory, 'resource');
      let destination: string | undefined;
      try {
        const files = await importVoiceFile(input.sourceFile, stagedFile);
        destination = this.mutations.paths.voiceFile(characterName, files.name);
        if (fs.existsSync(destination) || this.find(characterName, files.name)) {
          throw new CharacterResourceValidationError('resource_name_conflict');
        }
        await fs.promises.mkdir(this.mutations.paths.voiceRoot(characterName), { recursive: true });
        await fs.promises.rename(stagedFile, destination);
        try {
          const resource = this.insert(characterName, {
            name: files.name,
            displayName: files.displayName,
            promptText,
            promptLang,
            isPrimary: false,
            mimeType: validated.mimeType,
            byteSize: validated.byteSize,
            durationMs: validated.durationMs,
          });
          this.mutations.resourcesChanged(characterName);
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

  async export(characterName: string, voiceName: string, destination: string): Promise<string> {
    this.mutations.requireCharacter(characterName);
    const resource = this.find(characterName, voiceName);
    if (!resource) throw new CharacterResourceNotFoundError('voice_sample', voiceName);
    return exportVoiceFile(
      this.mutations.paths.voiceFile(characterName, voiceName),
      destination,
      resource.displayName,
    );
  }

  async delete(characterName: string, voiceName: string): Promise<CharacterVoiceSample | undefined> {
    return this.mutations.run(characterName, async () => {
      this.mutations.requireCharacter(characterName);
      const current = this.find(characterName, voiceName);
      if (!current) return undefined;
      const operationDirectory = this.mutations.createStagingOperation();
      const source = this.mutations.paths.voiceFile(characterName, voiceName);
      const staged = await this.mutations.stageExistingPath(source, operationDirectory);
      try {
        const deleted = this.deleteRecord(characterName, voiceName);
        if (!deleted && staged) await fs.promises.rename(staged, source);
        if (deleted) this.mutations.resourcesChanged(characterName);
        return deleted;
      } catch (error) {
        if (staged && !fs.existsSync(source)) await fs.promises.rename(staged, source);
        throw error;
      } finally {
        await removeDirectoryIfPresent(operationDirectory);
      }
    });
  }

  resolveFile(characterName: string, voiceName: string): string {
    this.mutations.requireCharacter(characterName);
    if (!this.find(characterName, voiceName)) {
      throw new CharacterResourceNotFoundError('voice_sample', voiceName);
    }
    return this.mutations.paths.voiceFile(characterName, voiceName);
  }
}
