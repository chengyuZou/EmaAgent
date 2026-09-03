// 应用 unified diff(对照 codex git-utils apply.rs)。
// 用系统 git apply,写临时 patch 文件;支持 preflight(--check)与 revert(-R)。
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitError } from './errors.js';
import { runGit } from './gitProcess.js';
import { GIT_WRITE_TIMEOUT_MS } from './limits.js';

export interface ApplyRequest {
  readonly cwd: string;
  readonly diff: string;
  /** 反向应用(git apply -R)。 */
  readonly revert?: boolean;
  /** 只检查不落盘(git apply --check),成功时 appliedPaths 为"将变更"清单。 */
  readonly preflight?: boolean;
}

export interface ApplyResult {
  readonly exitCode: number;
  /** 成功应用的路径(或 preflight 时"将应用"的路径);取自 diff 头部,不依赖 git 输出解析。 */
  readonly appliedPaths: readonly string[];
  /** 发生冲突/无法应用的路径;此时 appliedPaths 为空。 */
  readonly conflictedPaths: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 把 unified diff 应用到 cwd 指向的仓库工作区。
 * 失败(冲突/不适用)不抛异常,以 exitCode=1 + conflictedPaths 返回;
 * 只有 git 本身不可用/超时等环境错误才抛 GitError。
 */
export async function applyPatch(request: ApplyRequest): Promise<ApplyResult> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ema-git-apply-'));
  const patchFile = path.join(tmpDir, 'patch.diff');
  await fs.writeFile(patchFile, request.diff, 'utf8');
  try {
    const args = ['apply'];
    if (request.preflight) args.push('--check');
    else args.push('--3way');
    if (request.revert) args.push('-R');
    args.push(patchFile);

    try {
      const { stdout, stderr } = await runGit(request.cwd, args, { timeoutMs: GIT_WRITE_TIMEOUT_MS });
      return {
        exitCode: 0,
        appliedPaths: extractPathsFromDiff(request.diff),
        conflictedPaths: [],
        stdout,
        stderr,
      };
    } catch (error) {
      if (error instanceof GitError && error.code === 'git/command-failed') {
        const stderr = error.stderr ?? '';
        const paths = extractPathsFromDiff(request.diff);
        const conflicted = looksConflicted(stderr) ? paths : [];
        return {
          exitCode: 1,
          appliedPaths: conflicted.length === 0 ? paths : [],
          conflictedPaths: conflicted,
          stdout: '',
          stderr,
        };
      }
      throw error;
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * 从 unified diff 文本解析变更文件路径(diff --git a/x b/y 头;rename 取两端)。
 * 轻量子集:只扫头行拿路径清单;需要增删计数/分段时用 diff.ts 的 parseGitDiffSections。
 */
export function extractPathsFromDiff(diff: string): string[] {
  const paths: string[] = [];
  for (const line of diff.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    const rest = line.slice('diff --git '.length).trim();
    const parts = rest.split(/\s+/);
    if (parts.length < 2) continue;
    for (const part of [parts[0], parts[1]]) {
      if (part === undefined) continue;
      const p = stripPrefix(part);
      if (p && !paths.includes(p)) paths.push(p);
    }
  }
  return paths;
}

function stripPrefix(value: string): string {
  if (value === '/dev/null') return '';
  return value.startsWith('a/') || value.startsWith('b/') ? value.slice(2) : value;
}

function looksConflicted(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return s.includes('conflict') || s.includes('does not apply') || s.includes('patch failed');
}
