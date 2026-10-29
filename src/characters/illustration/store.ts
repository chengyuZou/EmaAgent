import { CharacterIllustrationRepo, type CharacterIllustrationRow } from '@ema-agent/storage';
import fs from 'node:fs';
import path from 'node:path';
import { CharacterMutations, assertResourcePatch } from '../resources/characterMutations.js';
import { removeDirectoryIfPresent, removeFileIfPresent } from '../resources/resourceFiles.js';
import {
  CharacterResourceNotFoundError,
  CharacterResourceValidationError,
  CharacterInputInvalidError,
} from '../errors.js';
import type { CharacterStagePresentation, CharacterIllustrationStageEntry } from '../types.js';
import type {
  CharacterIllustration,
  CharacterIllustrationInput,
  CharacterIllustrationPatch,
  ImportCharacterIllustrationInput,
} from './types.js';
import { ILLUSTRATION_EXPRESSION_POOL_MAX } from './limits.js';
import { exportImageFile, importImageFile, inspectImageFileSync } from '../resources/imageFiles.js';

function assertExpression(expression: string | null | undefined): void {
  if (expression !== undefined && expression !== null && !/^[a-z][a-z0-9_]*$/u.test(expression)) {
    throw new CharacterInputInvalidError('illustration_expression_invalid');
  }
}

function illustrationStageEntry(resource: CharacterIllustration): CharacterIllustrationStageEntry {
  return {
    kind: 'illustration',
    name: resource.name,
    displayName: resource.displayName,
    stageScale: resource.stageScale,
    stageOffsetX: resource.stageOffsetX,
    stageOffsetY: resource.stageOffsetY,
  };
}

function fromRow(row: CharacterIllustrationRow): CharacterIllustration {
  return {
    name: row.name,
    characterName: row.character_name,
    displayName: row.display_name,
    expression: row.expression,
    stageScale: row.stage_scale,
    stageOffsetX: row.stage_offset_x,
    stageOffsetY: row.stage_offset_y,
    isPrimary: row.is_primary === 1,
    byteSize: row.byte_size,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CharacterIllustrationStore {
  constructor(
    private readonly repo: CharacterIllustrationRepo,
    private readonly mutations: CharacterMutations,
  ) {}

  list(characterName: string): CharacterIllustration[] {
    return this.repo.listForCharacter(characterName).map(fromRow);
  }

  find(characterName: string, name: string): CharacterIllustration | undefined {
    const row = this.repo.find(characterName, name);
    return row ? fromRow(row) : undefined;
  }

  findPrimary(characterName: string): CharacterIllustration | undefined {
    const row = this.repo.findPrimary(characterName);
    return row ? fromRow(row) : undefined;
  }

  listForCharacters(characterNames: readonly string[]): Map<string, CharacterIllustration[]> {
    const grouped = new Map<string, CharacterIllustration[]>();
    for (const row of this.repo.listForCharacters(characterNames)) {
      const list = grouped.get(row.character_name) ?? [];
      list.push(fromRow(row));
      grouped.set(row.character_name, list);
    }
    return grouped;
  }

  insert(characterName: string, input: CharacterIllustrationInput): CharacterIllustration {
    const now = Date.now();
    this.repo.insert({ ...input, characterName, createdAt: now, updatedAt: now });
    return fromRow(this.repo.find(characterName, input.name)!);
  }

  private setPrimaryRecord(characterName: string, name: string): boolean {
    return this.repo.setPrimary(characterName, name, Date.now());
  }

  private updateRecord(characterName: string, name: string, patch: CharacterIllustrationPatch): CharacterIllustration | undefined {
    const row = this.repo.update(characterName, name, patch, Date.now());
    return row ? fromRow(row) : undefined;
  }

  private deleteRecord(characterName: string, name: string): CharacterIllustration | undefined {
    const row = this.repo.delete(characterName, name);
    return row ? fromRow(row) : undefined;
  }

  setPrimary(characterName: string, illustrationName: string): Promise<boolean> {
    return this.mutations.run(characterName, () => {
      const character = this.mutations.requireCharacter(characterName);
      if (!this.find(characterName, illustrationName)) {
        throw new CharacterResourceNotFoundError('illustration', illustrationName);
      }
      const changed = this.setPrimaryRecord(characterName, illustrationName);
      if (changed) {
        this.mutations.resourcesChanged(characterName);
        if (character.stageKind === 'illustration') this.mutations.presentationChanged(characterName);
      }
      return changed;
    });
  }

  update(characterName: string, illustrationName: string, patch: CharacterIllustrationPatch): Promise<CharacterIllustration | undefined> {
    return this.mutations.run(characterName, () => {
      const character = this.mutations.requireCharacter(characterName);
      assertResourcePatch(patch);
      assertExpression(patch.expression);
      this.assertExpressionCapacity(characterName, patch.expression, illustrationName);
      const resource = this.updateRecord(characterName, illustrationName, patch);
      if (resource) {
        this.mutations.resourcesChanged(characterName);
        if (character.stageKind === 'illustration') this.mutations.presentationChanged(characterName);
      }
      return resource;
    });
  }

  async import(characterName: string, input: ImportCharacterIllustrationInput): Promise<CharacterIllustration> {
    return this.mutations.run(characterName, async () => {
      const character = this.mutations.requireCharacter(characterName);
      assertExpression(input.expression);
      this.assertExpressionCapacity(characterName, input.expression);
      const operationDirectory = this.mutations.createStagingOperation();
      const stagedFile = path.join(operationDirectory, 'resource');
      let destination: string | undefined;
      try {
        const files = await importImageFile(input.sourceFile, stagedFile);
        destination = this.mutations.paths.illustrationFile(characterName, files.name);
        if (fs.existsSync(destination) || this.find(characterName, files.name)) {
          throw new CharacterResourceValidationError('resource_name_conflict');
        }
        await fs.promises.mkdir(this.mutations.paths.illustrationRoot(characterName), { recursive: true });
        await fs.promises.rename(stagedFile, destination);
        try {
          const resource = this.insert(characterName, {
            name: files.name,
            displayName: files.displayName,
            expression: input.expression ?? null,
            isPrimary: false,
            byteSize: files.byteSize,
          });
          this.mutations.resourcesChanged(characterName);
          if (character.stageKind === 'illustration') this.mutations.presentationChanged(characterName);
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

  async export(characterName: string, illustrationName: string, destination: string): Promise<string> {
    this.mutations.requireCharacter(characterName);
    const resource = this.find(characterName, illustrationName);
    if (!resource) throw new CharacterResourceNotFoundError('illustration', illustrationName);
    return exportImageFile(
      this.mutations.paths.illustrationFile(characterName, illustrationName),
      destination,
      resource.displayName,
    );
  }

  async delete(characterName: string, illustrationName: string): Promise<CharacterIllustration | undefined> {
    return this.mutations.run(characterName, async () => {
      const character = this.mutations.requireCharacter(characterName);
      const current = this.find(characterName, illustrationName);
      if (!current) return undefined;
      const operationDirectory = this.mutations.createStagingOperation();
      const source = this.mutations.paths.illustrationFile(characterName, illustrationName);
      const staged = await this.mutations.stageExistingPath(source, operationDirectory);
      try {
        const deleted = this.deleteRecord(characterName, illustrationName);
        if (!deleted && staged) await fs.promises.rename(staged, source);
        if (deleted) {
          this.mutations.resourcesChanged(characterName);
          if (character.stageKind === 'illustration') this.mutations.presentationChanged(characterName);
        }
        return deleted;
      } catch (error) {
        if (staged && !fs.existsSync(source)) await fs.promises.rename(staged, source);
        throw error;
      } finally {
        await removeDirectoryIfPresent(operationDirectory);
      }
    });
  }

  resolveFile(characterName: string, illustrationName: string): string {
    this.mutations.requireCharacter(characterName);
    if (!this.find(characterName, illustrationName)) {
      throw new CharacterResourceNotFoundError('illustration', illustrationName);
    }
    return this.mutations.paths.illustrationFile(characterName, illustrationName);
  }

  private assertExpressionCapacity(characterName: string, expression: string | null | undefined, excludingName?: string): void {
    if (!expression) return;
    // 编辑已有立绘时排除自身,否则把不改变 expression 的保存误判为超额.
    const count = this.list(characterName)
      .filter(resource => resource.name !== excludingName && resource.expression === expression).length;
    if (count >= ILLUSTRATION_EXPRESSION_POOL_MAX) {
      throw new CharacterInputInvalidError('illustration_expression_pool_full', characterName);
    }
  }

  presentation(characterName: string): CharacterStagePresentation {
    const resource = this.findPrimary(characterName);
    if (!resource) {
      return { status: 'unavailable', characterName, stageKind: 'illustration', reason: 'primary_resource_missing' };
    }
    const file = this.mutations.paths.illustrationFile(characterName, resource.name);
    const primaryFileState = inspectImageFileSync(file);
    if (primaryFileState !== 'valid') {
      return {
        status: 'unavailable',
        characterName,
        stageKind: 'illustration',
        reason: primaryFileState === 'missing' ? 'resource_file_missing' : 'resource_invalid',
      };
    }
    const expressions: Record<string, CharacterIllustrationStageEntry[]> = {};
    for (const item of this.list(characterName)) {
      if (!item.expression) continue;
      const itemFile = this.mutations.paths.illustrationFile(characterName, item.name);
      if (inspectImageFileSync(itemFile) !== 'valid') continue;
      (expressions[item.expression] ??= []).push(illustrationStageEntry(item));
    }
    return { status: 'illustration', characterName, resource: illustrationStageEntry(resource), expressions };
  }
}
