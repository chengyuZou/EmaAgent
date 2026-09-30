// Git 查询只返回原生 patch, 文件/hunk/行的解析由审查使用的 diff 包负责.
import { GitError, mapGitError } from './errors.js';
import { runGit } from './gitProcess.js';
import { findRepoRoot } from './repoDetection.js';
import { listUntrackedFiles } from './queries/status.js';
import {
  GIT_DIFF_CONTEXT_LINES,
  GIT_DIFF_MAX_TOTAL_CHARS,
  GIT_DIFF_MAX_UNTRACKED_FILES,
  GIT_DIFF_PROCESS_OUTPUT_BYTES,
  GIT_DIFF_UNTRACKED_CONCURRENCY,
} from './limits.js';
import type { GitCompareResult, GitDiffScope, GitWorkspaceDiffResult } from './types.js';

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
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
    return { capability: 'not-a-repo' };
  }

  try {
    const overrides = await filterDriverOverrides(repoRoot);
    const paths = scope === 'staged' ? [] : await listUntrackedFiles(repoRoot, overrides);
    if (paths.length > GIT_DIFF_MAX_UNTRACKED_FILES) {
      throw new GitError('git/diff-too-large', '未跟踪文件数量超出审查上限');
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
      capability: 'ok',
      repoRoot,
      patch: chunks.join(''),
      omittedFiles,
    };
  } catch (error) {
    return diffFailure(error);
  }
}

export type GitCompareTarget =
  | { readonly kind: 'commit'; readonly sha: string }
  | { readonly kind: 'branch'; readonly branch: string };

export async function gitCompareDiff(cwd: string, target: GitCompareTarget): Promise<GitCompareResult> {
  const repoRoot = await findRepoRoot(cwd);
  if (!repoRoot) {
    return { capability: 'not-a-repo' };
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
      capability: 'ok',
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
    throw new GitError('git/diff-too-large', 'Git 原始差异超出审查上限');
  }
}

function diffFailure(error: unknown): Exclude<GitWorkspaceDiffResult, { capability: 'ok' }> {
  if (
    error instanceof GitError
    && (error.code === 'git/output-too-large' || error.code === 'git/diff-too-large')
  ) {
    return { capability: 'diff-too-large' };
  }
  return mapGitError(error, (kind, message) => {
    if (kind === 'unavailable') {
      return { capability: 'git-unavailable' } as const;
    }
    return { capability: 'error', message } as const;
  });
}

// 工作区 diff 可能触发仓库的 clean/process helper, 延续已有禁用策略.
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

// 审查和 Memory 共用读取顺序, 各调用方决定总体预算和超限行为.
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
      // 由 Git 计算空树, 不硬编码 SHA-1 对象 ID.
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
    const patches = await Promise.all(batch.map(file => (
      diffUntrackedFile(repoRoot, extraConfig, file, maxOutputBytes).catch((error: unknown) => {
        if (error instanceof GitError && error.code === 'git/command-failed') {
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
