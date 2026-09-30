// 内部目录的可重置 diff 机制
// 用系统 git 实现"单 commit 基线":ensure → init + 首次提交;reset → add + amend 折叠为单 commit。
// 差异读取与审查共用, 基线写入只供内部 Memory 目录.
import { StringDecoder } from 'node:string_decoder';
import { GitError } from './errors.js';
import { runGit } from './gitProcess.js';
import { readWorkspacePatches } from './diff.js';
import { listUntrackedFiles } from './queries/status.js';
import {
  GIT_BASELINE_MAX_CHANGES_FOR_UNIFIED,
  GIT_BASELINE_MAX_DIFF_BYTES,
  GIT_WRITE_TIMEOUT_MS,
} from './limits.js';

const BASELINE_COMMIT_MESSAGE = 'EmaAgent memory baseline';
/**
 * 内部目录用固定作者,不读用户 git 配置;同时禁用 gpg 签名(防用户全局配置拖慢/挂起)、
 * 关闭 quotePath(保证路径原文可解析)、保持原样换行(autocrlf 会让 md 文件 diff 出现无意义 CRLF 变化)。
 */
const BASELINE_GIT_CONFIG: readonly string[] = [
  'user.name=EmaAgent',
  'user.email=noreply@ema.agent',
  'commit.gpgsign=false',
  'core.quotepath=false',
  'core.autocrlf=false',
];

export type BaselineChangeStatus = 'added' | 'modified' | 'deleted';

export interface BaselineChange {
  readonly status: BaselineChangeStatus;
  /** 仓库相对 POSIX 路径。 */
  readonly path: string;
}

export interface BaselineDiff {
  /** 文件级变化清单(永远完整,不受 unified diff 截断/跳过影响)。 */
  readonly changes: readonly BaselineChange[];
  /** 合并的 unified diff;超过 maxDiffBytes 按 UTF-8 字符边界截断;快探跳过时为空串。 */
  readonly unifiedDiff: string;
  /** unifiedDiff 是否因超过 maxDiffBytes 被截断。 */
  readonly truncated: boolean;
  /** 变化文件过多时按快探跳过 unified diff 渲染(claude fetchGitDiff 同款策略),changes 仍完整。 */
  readonly unifiedSkipped: boolean;
  /** 查询期间未能读取的文件数, 给 Memory 整合输入明确提示. */
  readonly omittedFiles: number;
}

export interface BaselineOptions {
  /** unified diff 上限,覆盖 settings 的 git.baseline.maxDiffBytes。 */
  readonly maxDiffBytes?: number;
}

/** .git 存在且 HEAD 可解析 → 基线可用。 */
export async function hasUsableBaseline(root: string): Promise<boolean> {
  try {
    await runGit(root, ['rev-parse', '--verify', 'HEAD'], { extraConfig: BASELINE_GIT_CONFIG });
    return true;
  } catch (error) {
    if (error instanceof GitError && error.code === 'git/command-failed') return false;
    throw error;
  }
}

/** 确保 root 有可用的单 commit 基线;已有可用 .git 保留,缺失/损坏则重建。 */
export async function ensureBaseline(root: string): Promise<void> {
  if (await hasUsableBaseline(root)) return;
  await resetBaseline(root);
}

/**
 * 把 root 重置为新的单 commit 基线(当前目录内容成为新的"上次")。
 * 首次:init + add + commit;之后:add + commit --amend 折叠历史为单 commit。
 */
export async function resetBaseline(root: string): Promise<void> {
  if (!(await hasUsableBaseline(root))) {
    await runGit(root, ['init', '-q'], { extraConfig: BASELINE_GIT_CONFIG, timeoutMs: GIT_WRITE_TIMEOUT_MS });
    await runGit(root, ['add', '-A'], { extraConfig: BASELINE_GIT_CONFIG, timeoutMs: GIT_WRITE_TIMEOUT_MS });
    await runGit(root, ['commit', '-q', '-m', BASELINE_COMMIT_MESSAGE, '--allow-empty', '--no-gpg-sign'], {
      extraConfig: BASELINE_GIT_CONFIG,
      timeoutMs: GIT_WRITE_TIMEOUT_MS,
    });
    return;
  }
  await runGit(root, ['add', '-A'], { extraConfig: BASELINE_GIT_CONFIG, timeoutMs: GIT_WRITE_TIMEOUT_MS });
  await runGit(root, ['commit', '-q', '--amend', '--no-edit', '--allow-empty', '--no-gpg-sign'], {
    extraConfig: BASELINE_GIT_CONFIG,
    timeoutMs: GIT_WRITE_TIMEOUT_MS,
  });
}

/**
 * 释放单提交基线因反复 amend 留下的旧对象。
 * 只供拥有整个内部仓库的业务调用；普通用户仓库不能使用这个操作。
 */
export async function compactBaselineStorage(root: string): Promise<void> {
  if (!(await hasUsableBaseline(root))) return;
  await runGit(root, ['reflog', 'expire', '--expire=now', '--all'], {
    extraConfig: BASELINE_GIT_CONFIG,
    timeoutMs: GIT_WRITE_TIMEOUT_MS,
  });
  await runGit(root, ['gc', '--prune=now', '--quiet'], {
    extraConfig: BASELINE_GIT_CONFIG,
    timeoutMs: GIT_WRITE_TIMEOUT_MS,
  });
}

/**
 * 返回自上次基线以来的变化:文件级清单(完整)+ unified diff(有界)。
 * 文件分类交给 Git, patch 读取与审查共用.
 * 变化文件过多时跳过 unified diff 渲染(快探),changes 仍完整。
 */
export async function diffSinceBaseline(
  root: string,
  options: BaselineOptions = {},
): Promise<BaselineDiff> {
  const maxDiffBytes = options.maxDiffBytes ?? GIT_BASELINE_MAX_DIFF_BYTES;

  const [added, modified, deleted, untracked] = await Promise.all([
    baselinePaths(root, 'A'),
    baselinePaths(root, 'MT'),
    baselinePaths(root, 'D'),
    listUntrackedFiles(root, BASELINE_GIT_CONFIG),
  ]);
  const changes: BaselineChange[] = [
    ...added.map(path => ({ status: 'added' as const, path })),
    ...modified.map(path => ({ status: 'modified' as const, path })),
    ...deleted.map(path => ({ status: 'deleted' as const, path })),
    ...untracked.map(path => ({ status: 'added' as const, path })),
  ];
  changes.sort((left, right) => left.path.localeCompare(right.path));

  // 快探:变化文件过多时不渲染 unified diff(claude fetchGitDiff 同款),避免拖慢整合。
  if (changes.length > GIT_BASELINE_MAX_CHANGES_FOR_UNIFIED) {
    return { changes, unifiedDiff: '', truncated: false, unifiedSkipped: true, omittedFiles: 0 };
  }

  const chunks: string[] = [];

  let bytes = 0;
  let truncated = false;
  let omittedFiles = 0;
  try {
    for await (const patch of readWorkspacePatches({
      repoRoot: root,
      scope: 'uncommitted',
      untrackedFiles: untracked,
      extraConfig: BASELINE_GIT_CONFIG,
      maxOutputBytes: Math.max(maxDiffBytes * 2, 8 * 1024 * 1024),
      detectRenames: false,
    })) {
      if (patch === null) {
        omittedFiles += 1;
        continue;
      }
      const buffer = Buffer.from(patch, 'utf8');
      const remaining = maxDiffBytes - bytes;
      if (buffer.length > remaining) {
        // Node 原生解码器保留完整字符, 不逐字符回退扫描整份正文.
        chunks.push(new StringDecoder('utf8').write(buffer.subarray(0, remaining)));
        truncated = true;
        break;
      }
      chunks.push(patch);
      bytes += buffer.length;
    }
  } catch (error) {
    if (!(error instanceof GitError) || error.code !== 'git/output-too-large') {
      throw error;
    }
    // 单次 Git 输出也有上限, 正文不完整时仍交付完整文件清单.
    truncated = true;
  }
  return {
    changes,
    unifiedDiff: chunks.join(''),
    truncated,
    unifiedSkipped: false,
    omittedFiles,
  };
}

async function baselinePaths(root: string, filter: 'A' | 'MT' | 'D'): Promise<string[]> {
  const { stdout } = await runGit(root, [
    'diff', 'HEAD', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv',
    `--diff-filter=${filter}`, '--',
  ], { extraConfig: BASELINE_GIT_CONFIG });
  return stdout.split('\0').filter(path => path.length > 0);
}
