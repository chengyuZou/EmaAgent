// 把 Server 传入的路径能力快照整理成各系统沙箱使用的配置。

import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { BARE_REPO_FILES } from './bareRepoSurface.js';
import type { SandboxCapability, SandboxConfig } from './types.js';

/**
 * 构造期已存在于工作区根的 bare-repo 敏感文件被叠为只读;
 * 构造后才"长出来"的 bare 签名由 CommandRunner.cleanup 精确处理,
 * 不在此处按文件名预杀(普通项目的 config/hooks 是无辜的)。
 *
 * 所有路径统一过 realpath: resolveCommandCwd 按真实路径校验 cwd,
 * 若绑定清单停留在文本路径, 符号链接工作区会出现"cwd 在真实路径、
 * 绑定在链接路径"的错位写入被拒; 不存在的路径保留文本解析结果。
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

  for (const fileName of BARE_REPO_FILES) {
    const targetPath = normalizePath(path.join(capability.workspaceRoot, fileName));
    try {
      statSync(targetPath);
      pushUnique(denyWrite, targetPath);
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
  return [...new Set(paths.filter(Boolean).map(normalizePath))];
}

/** 文本解析 + 真实路径; 与 resolveCommandCwd 的 realpathIfExists 同一语义(第二处, 暂不提取)。 */
function normalizePath(entry: string): string {
  const resolved = path.resolve(entry);
  try {
    const real = realpathSync.native(resolved);
    // Windows 的 realpathSync.native 返回 \\?\ 扩展前缀; 绑定清单是字符串参数
    // (WSL 路径翻译、SBPL 子路径), 前缀会让下游匹配全部失真, 必须剥掉。
    return real.startsWith('\\\\?\\') ? real.slice(4) : real;
  } catch {
    return resolved;
  }
}
