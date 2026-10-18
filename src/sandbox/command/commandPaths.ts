import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { SandboxCapability, SandboxConfig } from '../types.js';

/**
 * 已存在的路径解析为真实路径, 使沙箱绑定与命令工作目录使用同一目标.
 * 工作区根同时存在 bare Git 标记时, 才把已有仓库文件设为只读.
 * 尚不存在的可写或禁止路径保留解析后的绝对路径, 由后端处理.
 */
export function buildSandboxConfig(capability: SandboxCapability): SandboxConfig {
  const allowWrite = uniqueResolved(capability.writablePaths);
  const denyWrite: string[] = [];
  const denyRead: string[] = [];
  const pushUnique = (list: string[], entry: string): void => {
    if (!list.includes(entry)) list.push(entry);
  };

  for (const forbiddenPath of capability.forbiddenPaths) {
    const absolutePath = normalizePath(forbiddenPath);
    pushUnique(denyWrite, absolutePath);
    pushUnique(denyRead, absolutePath);
  }

  const repositoryFiles = hasBareRepoSignature(capability.cwd)
    ? ['HEAD', 'objects', 'refs', 'hooks', 'config']
    : [];
  for (const fileName of repositoryFiles) {
    const targetPath = normalizePath(path.join(capability.cwd, fileName));
    try {
      statSync(targetPath);
      pushUnique(denyWrite, targetPath);
    } catch {
      // 不为尚不存在的仓库条目创建占位文件.
    }
  }

  return {
    filesystem: { allowWrite, denyWrite, denyRead },
    network: { access: capability.networkAccess },
  };
}

function uniqueResolved(paths: readonly string[]): string[] {
  return [...new Set(paths.filter(Boolean).map(normalizePath))];
}

function normalizePath(entry: string): string {
  const resolved = path.resolve(entry);
  try {
    const real = realpathSync.native(resolved);
    // 去掉 Windows 扩展路径前缀, 后续 WSL 路径转换和 SBPL 规则使用普通路径文本.
    return real.startsWith('\\\\?\\') ? real.slice(4) : real;
  } catch {
    return resolved;
  }
}
function pathInside(root: string, target: string): boolean {
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const t = target.replace(/\\/g, '/');
  return t === r || t.startsWith(r + '/');
}
/**
 * 解析并校验命令工作目录. requested 省略时使用 cwd;
 * 相对路径以 cwd 为基准(不是 Core 进程 cwd);
 * Session cwd 本身始终可作为执行起点, 即使它已从项目目录清单移除;
 * 显式切换到别的目录只允许当前 writablePaths. 运行起点不等于写入授权.
 */
export function resolveCommandCwd(
  requested: string | undefined,
  capability: SandboxCapability,
): string {
  const resolved = path.resolve(capability.cwd, requested ?? '.');
  const real = normalizePath(resolved);
  if (real === normalizePath(path.resolve(capability.cwd))) return real;

  const roots = capability.writablePaths
    .map((r) => normalizePath(path.resolve(r)));
  if (!roots.some((root) => pathInside(root, real))) {
    throw new Error(`工作目录 ${real} 越出 Sandbox 能力范围`);
  }
  return real;
}

function hasBareRepoSignature(root: string): boolean {
  return ['HEAD', 'objects', 'refs'].every(fileName => {
    try {
      statSync(path.join(root, fileName));
      return true;
    } catch {
      return false;
    }
  });
}
