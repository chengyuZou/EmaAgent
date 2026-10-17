import {
  GitCommandError,
  GitDiffTooLargeError,
  GitOutputTooLargeError,
  toGitQueryFailure,
} from './errors.js';
import { runGit } from './gitProcess.js';
import { findRepoRoot } from './repoDetection.js';
import { listUntrackedFiles } from './queries/status.js';
import type { GitCompareResult, GitDiffScope, GitWorkspaceDiffResult } from './types.js';

const GIT_DIFF_CONTEXT_LINES = 3;
// 审查限制按 JavaScript 字符串长度计数, 与基线 diff 的 UTF-8 字节限制分开.
const GIT_DIFF_MAX_TOTAL_CHARS = 2_000_000;
const GIT_DIFF_MAX_UNTRACKED_FILES = 500;
const GIT_DIFF_UNTRACKED_CONCURRENCY = 8;
const GIT_DIFF_PROCESS_OUTPUT_BYTES = 8 * 1024 * 1024;
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
// UI 需要原生 patch 的文件头, 包括二进制, 空文件, 权限和重命名信息.
// 禁用颜色与外部 diff/textconv 程序, 保持可解析的 Git 输出.
const DIFF_FLAGS = [
  `-U${GIT_DIFF_CONTEXT_LINES}`,
  '--no-color',
  '--no-textconv',
  '--no-ext-diff',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--submodule=short',
  '--ignore-submodules=dirty',
] as const;

export async function gitWorkspaceDiff(cwd: string, scope: GitDiffScope): Promise<GitWorkspaceDiffResult> {
  const repoRoot = await findRepoRoot(cwd);
  if (!repoRoot) {
    return { status: 'not-a-repo' };
  }

  try {
    const overrides = await filterDriverOverrides(repoRoot);
    const paths = scope === 'staged' ? [] : await listUntrackedFiles(repoRoot, overrides);
    if (paths.length > GIT_DIFF_MAX_UNTRACKED_FILES) {
      throw new GitDiffTooLargeError(`more than ${GIT_DIFF_MAX_UNTRACKED_FILES} untracked files`);
    }
    const chunks: string[] = [];
    let totalChars = 0;
    let omittedFiles = 0;
    for await (const patch of readWorkspacePatches({
      repoRoot,
      scope,
      untrackedFiles: paths,
      extraConfig: overrides,
      maxOutputBytes: GIT_DIFF_PROCESS_OUTPUT_BYTES,
      detectRenames: true,
    })) {
      if (patch === null) {
        omittedFiles += 1;
        continue;
      }
      totalChars += patch.length;
      assertPatchSize(totalChars);
      chunks.push(patch);
    }
    return {
      repoRoot,
      patch: chunks.join(''),
      omittedFiles,
    };
  } catch (error) {
    return diffFailure(error);
  }
}

/** commit 读取该提交本身的 patch; branch 比较与该分支的共同祖先到当前磁盘的变化. */
export type GitCompareTarget =
  | { readonly kind: 'commit'; readonly sha: string }
  | { readonly kind: 'branch'; readonly branch: string };

export async function gitCompareDiff(cwd: string, target: GitCompareTarget): Promise<GitCompareResult> {
  const repoRoot = await findRepoRoot(cwd);
  if (!repoRoot) {
    return { status: 'not-a-repo' };
  }
  try {
    const overrides = await filterDriverOverrides(repoRoot);
    let args: string[];
    if (target.kind === 'commit') {
      args = ['show', '--format=', ...DIFF_FLAGS, target.sha, '--'];
    } else {
      const base = (await runGit(repoRoot, ['merge-base', 'HEAD', target.branch])).stdout.trim();
      args = ['diff', ...DIFF_FLAGS, base, '--'];
    }
    return {
      repoRoot,
      patch: await readPatch(repoRoot, args, overrides),
    };
  } catch (error) {
    return diffFailure(error);
  }
}

async function readPatch(repoRoot: string, args: readonly string[], extraConfig: readonly string[]): Promise<string> {
  const { stdout } = await runGit(repoRoot, args, {
    extraConfig,
    maxOutputBytes: GIT_DIFF_PROCESS_OUTPUT_BYTES,
  });
  assertPatchSize(stdout.length);
  return stdout;
}

function assertPatchSize(chars: number): void {
  if (chars > GIT_DIFF_MAX_TOTAL_CHARS) {
    throw new GitDiffTooLargeError(`patch exceeds ${GIT_DIFF_MAX_TOTAL_CHARS} string code units`);
  }
}

function diffFailure(error: unknown): Exclude<GitWorkspaceDiffResult, { readonly patch: string }> {
  if (
    error instanceof GitOutputTooLargeError
    || error instanceof GitDiffTooLargeError
  ) {
    return { status: 'diff-too-large' };
  }
  return toGitQueryFailure(error);
}

// 比较磁盘内容时 Git 可能执行 clean/process 程序, 查询时清空这些配置以免启动它们.
async function filterDriverOverrides(repoRoot: string): Promise<readonly string[]> {
  const { stdout } = await runGit(repoRoot, [
    'config',
    '--null',
    '--name-only',
    '--get-regexp',
    '^filter\\..*\\.(clean|process)$',
  ], {
    allowedExitCodes: [1],
  });
  const drivers = new Set<string>();
  for (const key of stdout.split('\0')) {
    const driver = key.replace(/\.(clean|process)$/, '');
    if (driver.startsWith('filter.') && driver.length > 'filter.'.length) {
      drivers.add(driver);
    }
  }
  return [...drivers].flatMap(driver => [`${driver}.clean=`, `${driver}.process=`]);
}

/**
 * 先返回已跟踪文件的 patch, 再按输入顺序分批读取未跟踪文件.
 * 未跟踪文件不能通过普通 git diff 读到, 因此逐个与空设备比较, 不写入用户索引.
 * null 表示某个未跟踪文件的 Git 命令失败, 让调用方计数并提示读取遗漏.
 */
export async function* readWorkspacePatches(input: {
  repoRoot: string;
  scope: GitDiffScope;
  untrackedFiles: readonly string[];
  extraConfig: readonly string[];
  maxOutputBytes: number;
  detectRenames: boolean;
}): AsyncGenerator<string | null> {
  const { repoRoot, scope, untrackedFiles, extraConfig, maxOutputBytes, detectRenames } = input;
  const args: string[] = ['diff', ...DIFF_FLAGS];
  if (!detectRenames) {
    args.push('--no-renames');
  }
  if (scope === 'staged') {
    args.push('--cached');
  } else if (scope === 'uncommitted') {
    const head = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD'], {
      extraConfig,
      allowedExitCodes: [1],
    });
    let base = 'HEAD';
    if (!head.stdout) {
      // 首次提交前以空树为起点, 让 Git 计算对象 ID 以同时支持 SHA-1 和 SHA-256 仓库.
      base = (await runGit(repoRoot, ['hash-object', '-t', 'tree', '--', NULL_DEVICE], {
        extraConfig,
      })).stdout.trim();
    }
    args.push(base);
  }
  args.push('--');
  yield (await runGit(repoRoot, args, { extraConfig, maxOutputBytes })).stdout;

  for (let index = 0; index < untrackedFiles.length; index += GIT_DIFF_UNTRACKED_CONCURRENCY) {
    const batch = untrackedFiles.slice(index, index + GIT_DIFF_UNTRACKED_CONCURRENCY);
    // 每批最多启动固定数量的 Git 进程, Promise.all 保留输入路径的顺序.
    const patches = await Promise.all(batch.map(file => (
      diffUntrackedFile(repoRoot, extraConfig, file, maxOutputBytes).catch((error: unknown) => {
        if (error instanceof GitCommandError) {
          return null;
        }
        throw error;
      })
    )));
    yield* patches;
  }
}

async function diffUntrackedFile(
  repoRoot: string,
  extraConfig: readonly string[],
  file: string,
  maxOutputBytes: number,
): Promise<string> {
  const { stdout } = await runGit(repoRoot, [
    'diff',
    '--no-index',
    ...DIFF_FLAGS,
    '--',
    NULL_DEVICE,
    file,
  ], {
    extraConfig,
    allowedExitCodes: [1],
    maxOutputBytes,
  });
  return stdout;
}
