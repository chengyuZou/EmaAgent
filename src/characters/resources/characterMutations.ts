import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { CharacterCard } from '../types.js';
import { CharacterInputInvalidError } from '../errors.js';
import { CharacterResourcePaths } from './resourcePaths.js';

/** 角色删除与各类资源修改共用队列, 避免导入文件期间角色目录被另一项操作移走. */
export class CharacterMutations {
  private readonly mutationTails = new Map<string, Promise<void>>();

  constructor(
    readonly paths: CharacterResourcePaths,
    readonly requireCharacter: (name: string) => CharacterCard,
    // 资源文件与 SQL 保存成功后通知 CharacterStore, 更新时间并刷新各窗口的资源列表.
    readonly resourcesChanged: (name: string) => void,
    // 仅影响舞台表现的修改调用此入口, CharacterStore 重新读取映射并通知 Stage.
    readonly presentationChanged: (name: string) => void,
  ) {}

  run<T>(characterName: string, action: () => T | Promise<T>): Promise<T> {
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

  createStagingOperation(): string {
    const directory = this.paths.stagingOperationDirectory(crypto.randomUUID());
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }

  async stageExistingPath(source: string, operationDirectory: string): Promise<string | null> {
    if (!await fs.promises.stat(source).catch(() => null)) return null;
    // 每次操作拥有独立 UUID 目录,因此固定使用 `deleted` 不会与其他角色操作冲突.
    const staged = path.join(operationDirectory, 'deleted');
    await fs.promises.rename(source, staged);
    return staged;
  }
}

export function assertResourcePatch(patch: {
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
