// 把 LocalHost 传入的路径能力快照整理成各系统沙箱使用的配置。

import { statSync } from 'node:fs';
import path from 'node:path';
import type { SandboxCapability, SandboxConfig } from './types.js';

const BARE_REPO_FILES = ['HEAD', 'objects', 'refs', 'hooks', 'config'] as const;

/**
 * 构造期已存在于工作区根的 bare-repo 敏感文件被叠为只读;
 * 构造后才"长出来"的 bare 签名由 CommandRunner.cleanup 精确处理,
 * 不在此处按文件名预杀(普通项目的 config/hooks 是无辜的)。
 */
export function buildSandboxConfig(capability: SandboxCapability): SandboxConfig {
  const allowWrite = uniqueResolved(capability.writablePaths);
  const denyWrite: string[] = [];
  const denyRead: string[] = [];

  for (const forbiddenPath of capability.forbiddenPaths) {
    const absolutePath = path.resolve(forbiddenPath);
    if (!denyWrite.includes(absolutePath)) denyWrite.push(absolutePath);
    if (!denyRead.includes(absolutePath)) denyRead.push(absolutePath);
  }

  for (const fileName of BARE_REPO_FILES) {
    const targetPath = path.resolve(capability.workspaceRoot, fileName);
    try {
      statSync(targetPath);
      if (!denyWrite.includes(targetPath)) denyWrite.push(targetPath);
    } catch {
      // 不存在: 不预设只读, 也不预登记删除, 由 cleanup 按完整签名判定。
    }
  }

  return {
    filesystem: { allowWrite, denyWrite, denyRead },
    network: { access: capability.networkAccess },
  };
}

function uniqueResolved(paths: readonly string[]): string[] {
  return [...new Set(paths.filter(Boolean).map((entry) => path.resolve(entry)))];
}
