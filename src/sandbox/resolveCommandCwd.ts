// 命令工作目录解析: 规范化、真实路径(符号链接/junction)与能力范围校验。
// CommandRunnerPort 是公共能力, 调用方传入的 cwd 不能越出 LocalHost 冻结的快照。

import fs from 'node:fs';
import path from 'node:path';
import type { SandboxCapability } from './types.js';

function pathInside(root: string, target: string): boolean {
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const t = target.replace(/\\/g, '/');
  return t === r || t.startsWith(r + '/');
}

/** 真实路径; 目录不存在时返回解析结果(spawn 会以 ENOENT 诚实失败)。 */
function realpathIfExists(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * 解析并校验命令工作目录。requested 省略时使用 workspaceRoot;
 * 相对路径以 workspaceRoot 为基准(不是 Core 进程 cwd);
 * 结果必须位于 workspaceRoot 或 writablePaths 之一(按真实路径比较,
 * 防符号链接/junction 逃逸), 否则拒绝而不是悄悄执行。
 */
export function resolveCommandCwd(
  requested: string | undefined,
  capability: SandboxCapability,
): string {
  const resolved = path.resolve(capability.workspaceRoot, requested ?? '.');
  const real = realpathIfExists(resolved);

  const roots = [capability.workspaceRoot, ...capability.writablePaths]
    .map((r) => realpathIfExists(path.resolve(r)));
  if (!roots.some((root) => pathInside(root, real))) {
    throw new Error(`工作目录 ${real} 越出 Sandbox 能力范围`);
  }
  return real;
}
