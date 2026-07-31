// 在角色根目录同盘暂存文件，发布成功前不让半份资源成为正式数据。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CharacterCardId } from '@ema-agent/ids';
import type { CharacterResourceKind } from '../resources/characterResourcePaths.js';
import { CharacterResourcePaths } from '../resources/characterResourcePaths.js';
import {
  CHARACTER_RESOURCE_PAYLOAD_NAME,
  createOperationDirectory,
  moveWithoutOverwrite,
  removeOperationDirectory,
  writeOperationManifest,
} from '../resources/characterResourceFiles.js';

export class CharacterResourceStaging {
  constructor(private readonly paths: CharacterResourcePaths) {}

  async publishPrepared<TPrepared, TResult>({
    characterId,
    resourceKind,
    resourceId,
    relativePath,
    targetRelativePath = relativePath,
    prepare,
    commit,
    isReferenced,
  }: {
    characterId: CharacterCardId;
    resourceKind: CharacterResourceKind;
    resourceId: string;
    relativePath: string;
    targetRelativePath?: string;
    prepare: (payloadPath: string) => Promise<TPrepared>;
    commit: (prepared: TPrepared) => TResult;
    isReferenced: () => boolean;
  }): Promise<TResult> {
    const target = this.paths.resolve(
      characterId,
      false,
      targetRelativePath,
      resourceKind,
    );
    const operationId = randomUUID();
    const directory = createOperationDirectory(
      this.paths.operationRoot('imports'),
      operationId,
    );
    const payload = path.join(directory, CHARACTER_RESOURCE_PAYLOAD_NAME);
    let published = false;
    try {
      if (fs.existsSync(target)) {
        throw new Error(`character resource destination already exists: ${target}`);
      }
      writeOperationManifest(directory, {
        schemaVersion: 2,
        operationId,
        type: 'publish',
        characterId,
        resourceKind,
        resourceId,
        relativePath,
        targetRelativePath,
      });
      const prepared = await prepare(payload);
      moveWithoutOverwrite(payload, target);
      published = true;
      const result = commit(prepared);
      try {
        removeOperationDirectory(directory);
      } catch {
        // 数据库已经提交；残留清单由启动恢复按事实源清理。
      }
      return result;
    } catch (error) {
      const referenced = isReferenced();
      if (published && !referenced && fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
      }
      if (!referenced) removeOperationDirectory(directory);
      throw error;
    }
  }
}
