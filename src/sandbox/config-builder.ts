// 把 Core 传入的真实路径和权限规则整理成各系统沙箱使用的配置。

import { statSync } from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import type { PermissionRule } from '@ema-agent/permission';
import type { SandboxConfig } from './types.js';
import { getPlatform } from './platform.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * 这些文件若同时出现在工作区根目录，会让 git 把目录当成 bare 仓库并执行
 * core.fsmonitor。参考：anthropics/claude-code#29316 - "bare-repo escape" 攻击。
 */
const BARE_REPO_FILES = ['HEAD', 'objects', 'refs', 'hooks', 'config'] as const;

// ── Context ───────────────────────────────────────────────────────────────────

export interface ConfigContext {
  workspaceRoot: string;
  sessionId?:    string;
  /** Core 指定的私有文件或目录，沙箱进程一律不能读取或修改。 */
  protectedPaths: readonly string[];
  /** V1 只有完全断网和全网访问两档。 */
  networkAccess: 'none' | 'full';
}

// ── Builder output ────────────────────────────────────────────────────────────

export interface BuildResult {
  config:     SandboxConfig;
  /**
   * 构建配置时还不存在、但位于工作区内的路径。
   * cleanup() 会在沙箱命令跑完后删除这些路径，防止植入的 bare-repo 逃逸
   * 残留到下一次 git 调用。
   */
  scrubPaths: string[];
}

// TODO 死代码：下方 buildSandboxConfig 里 :89-103 的规则推导用 'fs-edit'/'fs-write'/'fs-read'
//  作为 rule.tool 匹配值，但 permission 规则实际用 BuiltinTools.*.id（如 'builtin.file.read'）。
//  这些值永不匹配，整段 for 循环是死代码，permission 的路径规则不会传导到沙箱配置。
//  更深的问题：permission 管"能否调工具"，sandbox 管"进程能碰什么文件"，是两个维度，
//  从 permission 规则推 sandbox allowWrite 本身语义错位。沙箱配置该有独立来源
//  （Core 注入可写路径），不该从 permission 规则猜。设计问题，待 sandbox 批次重做。

// ── Main builder ──────────────────────────────────────────────────────────────

export function buildSandboxConfig(
  rules:   ReadonlyArray<PermissionRule>,
  ctx:     ConfigContext,
): BuildResult {
  // macOS 的 os.tmpdir() 返回 /var/folders/...，而工具常写 /tmp -> /private/tmp。
  // 两都纳入，避免沙箱误拦合法的临时文件操作。
  const macOsTmpExtras = getPlatform() === 'macos' ? ['/tmp', '/private/tmp'] : [];

  const allowWrite: string[] = [
    ...(ctx.workspaceRoot ? [path.resolve(ctx.workspaceRoot)] : []),
    os.tmpdir(),
    ...macOsTmpExtras,
  ];
  const denyWrite:  string[] = [];
  const denyRead:   string[] = [];
  const allowRead:  string[] = [];

  // 这些路径由 Core 提供，Sandbox 不再猜 profile 或 data 目录。
  for (const protectedPath of ctx.protectedPaths) {
    const absolutePath = path.resolve(protectedPath);
    if (!denyWrite.includes(absolutePath)) denyWrite.push(absolutePath);
    if (!denyRead.includes(absolutePath)) denyRead.push(absolutePath);
  }

  // bare-repo 攻击防护 ────────────────────────────────────────────────────────
  // 沙箱命令可能在工作区根目录植入 HEAD/objects/refs/hooks/config，
  // 触发下一次 git 调用的 bare-repo 逃逸。
  //
  // 已存在的文件：加进 denyWrite，沙箱内挂只读。
  // 不存在的文件：记进 scrubPaths，cleanup() 删掉命令跑完后出现的植入文件。
  const scrubPaths: string[] = [];
  if (ctx.workspaceRoot) {
    for (const file of BARE_REPO_FILES) {
      const p = path.resolve(ctx.workspaceRoot, file);
      try {
        statSync(p);            // 不存在则抛 ENOENT
        denyWrite.push(p);      // 存在 -> 沙箱内只读
      } catch {
        scrubPaths.push(p);     // 不存在 -> 命令跑完后若出现则删除
      }
    }
  }

  // Permission rules -> sandbox filesystem paths ─────────────────────────────
  // TODO 死代码：见文件顶部说明。rule.tool 永不等于 'fs-edit'/'fs-write'/'fs-read'。
  for (const rule of rules) {
    if (!rule.pathGlob) continue;

    const base = resolveGlobBase(rule.pathGlob, ctx.workspaceRoot || '');

    if (rule.tool === 'fs-edit' || rule.tool === 'fs-write') {
      if (rule.action === 'allow') allowWrite.push(base);
      else if (rule.action === 'deny') denyWrite.push(base);
    }

    if (rule.tool === 'fs-read') {
      if (rule.action === 'allow') allowRead.push(base);
      else if (rule.action === 'deny') denyRead.push(base);
    }
  }

  return {
    config: {
      filesystem: { allowWrite, denyWrite, denyRead, allowRead },
      network:    { access: ctx.networkAccess },
    },
    scrubPaths,
  };
}

// ── Path resolution ───────────────────────────────────────────────────────────

/**
 * 从 pathGlob 提取基础目录，供 bubblewrap/sandbox-exec bind-mount。
 * 剥离尾部 /** 并解析前缀约定。
 *
 * 约定（对齐 permission/rules.ts 的 resolvePatternRoot）：
 *   //abs/path/**  -> /abs/path   （锚定文件系统根）
 *   ~/rel/**       -> ~/rel       （锚定 home 目录）
 *   /rel/**        -> workspaceRoot/rel
 *   rel/**         -> workspaceRoot/rel
 */
function resolveGlobBase(glob: string, workspaceRoot: string): string {
  const stripped = glob.endsWith('/**') ? glob.slice(0, -3) : glob;

  if (stripped.startsWith('//')) {
    // 锚定文件系统根 - 对齐 permission/rules.ts 的 resolvePatternRoot()。
    // Windows 上盘符取自 workspaceRoot（同约定）。
    if (getPlatform() === 'windows') {
      const drive = workspaceRoot.slice(0, 3) || (process.env['SystemDrive'] ?? 'C:') + '\\';
      return path.join(drive, stripped.slice(2).replace(/\//g, path.sep));
    }
    return stripped.slice(1);   // //abs/path -> /abs/path（Linux/macOS）
  }

  if (stripped.startsWith('~/')) return path.join(os.homedir(), stripped.slice(2));
  if (stripped.startsWith('/'))  return path.resolve(workspaceRoot, stripped.slice(1));

  return path.resolve(workspaceRoot, stripped.startsWith('./') ? stripped.slice(2) : stripped);
}