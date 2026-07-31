// 先把受管资源移入回收区，再提交数据库删除，并在失败时恢复原路径。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CharacterCardId } from '@ema-agent/ids';
import type {
  CharacterResourceKind,
} from './characterResourcePaths.js';
import { CharacterResourcePaths } from './characterResourcePaths.js';
import {
  CHARACTER_RESOURCE_PAYLOAD_NAME,
  createOperationDirectory,
  moveWithoutOverwrite,
  removeOperationDirectory,
  writeOperationManifest,
} from './characterResourceFiles.js';

export class CharacterResourceTrash {
  constructor(private readonly paths: CharacterResourcePaths) {}

  delete<T>({
    characterId,
    resourceKind,
    resourceId,
    relativePath,
    commit,
    isReferenced,
  }: {
    characterId: CharacterCardId;
    resourceKind: CharacterResourceKind;
    resourceId: string;
    relativePath: string;
    commit: () => T;
    isReferenced: () => boolean;
  }): T {
    const source = this.paths.resolve(
      characterId,
      false,
      relativePath,
      resourceKind,
    );
    if (!fs.existsSync(source)) return commit();

    const operationId = randomUUID();
    const directory = createOperationDirectory(
      this.paths.operationRoot('trash'),
      operationId,
    );
    const payload = path.join(directory, CHARACTER_RESOURCE_PAYLOAD_NAME);
    try {
      writeOperationManifest(directory, {
        schemaVersion: 1,
        operationId,
        type: 'delete',
        characterId,
        resourceKind,
        resourceId,
        relativePath,
      });
      moveWithoutOverwrite(source, payload);
      const result = commit();
      try {
        removeOperationDirectory(directory);
      } catch {
        // 数据库已经提交；残留清单由启动恢复按事实源清理。
      }
      return result;
    } catch (error) {
      const referenced = isReferenced();
      if (referenced && fs.existsSync(payload) && !fs.existsSync(source)) {
        moveWithoutOverwrite(payload, source);
      }
      if (!fs.existsSync(payload) || !referenced) removeOperationDirectory(directory);
      throw error;
    }
  }

  deleteCharacter<T>({
    characterId,
    commit,
    isReferenced,
  }: {
    characterId: CharacterCardId;
    commit: () => T;
    isReferenced: () => boolean;
  }): T {
    const source = this.paths.cardRoot(characterId, false);
    if (!fs.existsSync(source)) return commit();

    const operationId = randomUUID();
    const directory = createOperationDirectory(
      this.paths.operationRoot('trash'),
      operationId,
    );
    const payload = path.join(directory, CHARACTER_RESOURCE_PAYLOAD_NAME);
    try {
      writeOperationManifest(directory, {
        schemaVersion: 1,
        operationId,
        type: 'delete',
        characterId,
        resourceKind: 'character',
        resourceId: characterId,
        relativePath: '',
      });
      moveWithoutOverwrite(source, payload);
      const result = commit();
      try {
        removeOperationDirectory(directory);
      } catch {
        // 数据库已经提交；残留清单由启动恢复按事实源清理。
      }
      return result;
    } catch (error) {
      const referenced = isReferenced();
      if (referenced && fs.existsSync(payload) && !fs.existsSync(source)) {
        moveWithoutOverwrite(payload, source);
      }
      if (!fs.existsSync(payload) || !referenced) removeOperationDirectory(directory);
      throw error;
    }
  }
}
