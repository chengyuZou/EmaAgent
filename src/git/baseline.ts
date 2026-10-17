import { StringDecoder } from 'node:string_decoder';
import { GitCommandError, GitOutputTooLargeError } from './errors.js';
import { runGit } from './gitProcess.js';
import { readWorkspacePatches } from './diff.js';
import { listUntrackedFiles } from './queries/status.js';

const GIT_WRITE_TIMEOUT_MS = 30_000;
const GIT_BASELINE_MAX_DIFF_BYTES = 4 * 1024 * 1024;
const GIT_BASELINE_MAX_CHANGES_FOR_UNIFIED = 200;
const BASELINE_COMMIT_MESSAGE = 'EmaAgent baseline';
/**
 * 固定作者并关闭提交签名, 让内部提交无需用户配置身份或提供签名凭据.
 * 保留可读路径和原始换行, 避免 Markdown diff 混入自动换行转换产生的变化.
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
  /** 相对仓库根目录的路径, 目录分隔符为 /. */
  readonly path: string;
}

export interface BaselineDiff {
  /** 单独查询的文件清单, 不随 unifiedDiff 的截断或跳过而裁剪. */
  readonly changes: readonly BaselineChange[];
  /** 超过 maxDiffBytes 时在完整 UTF-8 字符处截断, unifiedSkipped 时为空字符串. */
  readonly unifiedDiff: string;
  /** 正文是否因 maxDiffBytes 或单次 Git 输出限制而不完整. */
  readonly truncated: boolean;
  /** 超过 GIT_BASELINE_MAX_CHANGES_FOR_UNIFIED 时只返回文件清单, 跳过正文. */
  readonly unifiedSkipped: boolean;
  /** 查询期间未能读取的文件数, 给 Memory 整合输入明确提示. */
  readonly omittedFiles: number;
}

export interface BaselineOptions {
  /** 正文的 UTF-8 字节上限, 缺省使用 GIT_BASELINE_MAX_DIFF_BYTES. */
  readonly maxDiffBytes?: number;
}

/** 在 root 执行 Git 能否解析 HEAD. Git 会向上查找仓库, 调用方须传入独立仓库根目录. */
export async function hasUsableBaseline(root: string): Promise<boolean> {
  try {
    await runGit(root, ['rev-parse', '--verify', 'HEAD'], { extraConfig: BASELINE_GIT_CONFIG });
    return true;
  } catch (error) {
    if (error instanceof GitCommandError) return false;
    throw error;
  }
}

/** 保留已有的可解析 HEAD, 否则调用 resetBaseline. root 需满足该函数的目录要求. */
export async function ensureBaseline(root: string): Promise<void> {
  if (await hasUsableBaseline(root)) return;
  await resetBaseline(root);
}

/**
 * 接受当前目录内容作为下一次比较的基线.
 * root 必须是业务独占的仓库根目录, 传入普通子目录可能让 Git 修改父仓库.
 * 首次初始化并提交, 后续 add -A 再 amend 最后一次提交, 正常的单提交基线因此保持一条提交.
 * 这会改变索引和 HEAD, 并保留当前磁盘内容; 调用方需要串行执行同一目录的读写任务.
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
 * 清理反复 amend 留下的旧对象, 减少 Memory 内部仓库占用的磁盘空间.
 * 调用方必须独占该仓库且没有 Git 任务正在执行, 过期 reflog 与旧对象会被立即清理.
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
 * 比较当前 HEAD 与磁盘内容, 并加入未跟踪文件. 重命名表示为删除和新增.
 * 文件清单先单独读取, 正文过大或文件过多时仍可用清单选择需要检查的文件.
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

  // 文件过多时整合任务先读取清单, 避免为全部文件生成大段 patch.
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
        // 截点可能落在中文等多字节字符中间, 解码器会暂存不完整字节, 不输出半个字符.
        chunks.push(new StringDecoder('utf8').write(buffer.subarray(0, remaining)));
        truncated = true;
        break;
      }
      chunks.push(patch);
      bytes += buffer.length;
    }
  } catch (error) {
    if (!(error instanceof GitOutputTooLargeError)) {
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
