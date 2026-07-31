// 依据 SQLite 事实源恢复中断的角色资源发布与删除，不猜测未知目录。

import fs from 'node:fs';
import path from 'node:path';
import { CharacterResourcePaths } from './characterResourcePaths.js';
import {
  CHARACTER_RESOURCE_PAYLOAD_NAME,
  listOperationDirectories,
  moveWithoutOverwrite,
  readOperationManifest,
  removeOperationDirectory,
  type CharacterResourceTransactionManifest,
} from './characterResourceFiles.js';

export interface CharacterResourceReference {
  readonly sameResource: boolean;
  readonly pathReferenced: boolean;
}

export interface CharacterResourceRecoveryReport {
  readonly restored: number;
  readonly removed: number;
  readonly failed: number;
}

export class CharacterResourceRecovery {
  constructor(
    private readonly paths: CharacterResourcePaths,
    private readonly lookupReference: (
      manifest: CharacterResourceTransactionManifest,
    ) => CharacterResourceReference,
  ) {}

  run(): CharacterResourceRecoveryReport {
    const report = { restored: 0, removed: 0, failed: 0 };
    this.recoverRoot(this.paths.operationRoot('imports'), 'publish', report);
    this.recoverRoot(this.paths.operationRoot('trash'), 'delete', report);
    return report;
  }

  private recoverRoot(
    root: string,
    expectedType: 'publish' | 'delete',
    report: { restored: number; removed: number; failed: number },
  ): void {
    for (const directory of listOperationDirectories(root)) {
      const manifest = readOperationManifest(directory);
      if (!manifest || manifest.type !== expectedType) {
        report.failed += 1;
        continue;
      }
      try {
        expectedType === 'publish'
          ? this.recoverPublish(directory, manifest, report)
          : this.recoverDelete(directory, manifest, report);
      } catch {
        // Windows 文件占用或损坏清单留待下一次启动重试，不能伪装清理成功。
        report.failed += 1;
      }
    }
  }

  private recoverPublish(
    directory: string,
    manifest: CharacterResourceTransactionManifest,
    report: { restored: number; removed: number },
  ): void {
    if (manifest.resourceKind === 'character') {
      throw new Error('character publish is not supported in C3a');
    }
    const target = this.paths.resolve(
      manifest.characterId,
      false,
      manifest.relativePath,
      manifest.resourceKind,
    );
    const payload = path.join(directory, CHARACTER_RESOURCE_PAYLOAD_NAME);
    const reference = this.lookupReference(manifest);

    if (reference.sameResource) {
      if (!fs.existsSync(target) && fs.existsSync(payload)) {
        moveWithoutOverwrite(payload, target);
        report.restored += 1;
      }
      removeOperationDirectory(directory);
      report.removed += 1;
      return;
    }

    // 后续操作已经复用了同一路径时，绝不能删除新资源。
    if (!reference.pathReferenced && fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    removeOperationDirectory(directory);
    report.removed += 1;
  }

  private recoverDelete(
    directory: string,
    manifest: CharacterResourceTransactionManifest,
    report: { restored: number; removed: number },
  ): void {
    const source = manifest.resourceKind === 'character'
      ? this.paths.cardRoot(manifest.characterId, false)
      : this.paths.resolve(
        manifest.characterId,
        false,
        manifest.relativePath,
        manifest.resourceKind,
      );
    const payload = path.join(directory, CHARACTER_RESOURCE_PAYLOAD_NAME);
    const reference = this.lookupReference(manifest);

    if (reference.sameResource && !fs.existsSync(source) && fs.existsSync(payload)) {
      moveWithoutOverwrite(payload, source);
      report.restored += 1;
    }
    removeOperationDirectory(directory);
    report.removed += 1;
  }
}
