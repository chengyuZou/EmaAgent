// 把 Core 传入的路径能力快照整理成各系统沙箱使用的配置。

import { statSync } from 'node:fs';
import path from 'node:path';
import type { SandboxCapability, SandboxConfig } from './types.js';

const BARE_REPO_FILES = ['HEAD', 'objects', 'refs', 'hooks', 'config'] as const;

export interface BuildResult {
  config: SandboxConfig;
  /**
   * 命令执行前还不存在的 bare-repo 攻击路径。
   * 命令结束后统一清理，防止下一次 Git 调用加载攻击者植入的配置。
   */
  scrubPaths: string[];
}

export function buildSandboxConfig(capability: SandboxCapability): BuildResult {
  const allowWrite = uniqueResolved(capability.writablePaths);
  const denyWrite: string[] = [];
  const denyRead: string[] = [];
  const allowRead: string[] = [];

  for (const protectedPath of capability.protectedPaths) {
    const absolutePath = path.resolve(protectedPath);
    if (!denyWrite.includes(absolutePath)) denyWrite.push(absolutePath);
    if (!denyRead.includes(absolutePath)) denyRead.push(absolutePath);
  }

  const scrubPaths: string[] = [];
  for (const fileName of BARE_REPO_FILES) {
    const targetPath = path.resolve(capability.workspaceRoot, fileName);
    try {
      statSync(targetPath);
      if (!denyWrite.includes(targetPath)) denyWrite.push(targetPath);
    } catch {
      scrubPaths.push(targetPath);
    }
  }

  return {
    config: {
      filesystem: { allowWrite, denyWrite, denyRead, allowRead },
      network: { access: capability.networkAccess },
    },
    scrubPaths,
  };
}

function uniqueResolved(paths: readonly string[]): string[] {
  return [...new Set(paths.filter(Boolean).map((entry) => path.resolve(entry)))];
}
