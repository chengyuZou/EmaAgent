// 内部目录的可重置 diff 机制(对照 codex git-utils baseline.rs)。
// 用系统 git 实现"单 commit 基线":ensure → init + 首次提交;reset → add + amend 折叠为单 commit。
// 与 codex 语义一致:diff = HEAD 树 vs 当前目录内容(含 untracked 新增)。
// untracked 伪 diff 复用 diff.ts 的成熟实现(listUntrackedFiles / diffUntrackedFile),不重复造轮子。
import { GitError } from './errors.js';
import { runGit } from './gitProcess.js';
import { diffUntrackedFile } from './diff.js';
import { DEFAULT_GIT_SETTINGS, type GitSettings } from './settings.js';

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
export async function ensureBaseline(
  root: string,
  settings: GitSettings = DEFAULT_GIT_SETTINGS,
): Promise<void> {
  if (await hasUsableBaseline(root)) return;
  await resetBaseline(root, settings);
}

/**
 * 把 root 重置为新的单 commit 基线(当前目录内容成为新的"上次")。
 * 首次:init + add + commit;之后:add + commit --amend 折叠历史为单 commit。
 * 与 codex reset 语义一致,但不删 .git、不积累提交历史。
 */
export async function resetBaseline(
  root: string,
  settings: GitSettings = DEFAULT_GIT_SETTINGS,
): Promise<void> {
  const writeTimeout = settings.writeTimeoutMs;
  if (!(await hasUsableBaseline(root))) {
    await runGit(root, ['init', '-q'], { extraConfig: BASELINE_GIT_CONFIG, timeoutMs: writeTimeout });
    await runGit(root, ['add', '-A'], { extraConfig: BASELINE_GIT_CONFIG, timeoutMs: writeTimeout });
    await runGit(root, ['commit', '-q', '-m', BASELINE_COMMIT_MESSAGE, '--no-gpg-sign'], {
      extraConfig: BASELINE_GIT_CONFIG,
      timeoutMs: writeTimeout,
    });
    return;
  }
  await runGit(root, ['add', '-A'], { extraConfig: BASELINE_GIT_CONFIG, timeoutMs: writeTimeout });
  await runGit(root, ['commit', '-q', '--amend', '--no-edit', '--allow-empty', '--no-gpg-sign'], {
    extraConfig: BASELINE_GIT_CONFIG,
    timeoutMs: writeTimeout,
  });
}

/**
 * 返回自上次基线以来的变化:文件级清单(完整)+ unified diff(有界)。
 * tracked 变化走 git diff HEAD;untracked 新增复用 diff.ts 的 --no-index 伪 diff。
 * 变化文件过多时跳过 unified diff 渲染(快探),changes 仍完整。
 */
export async function diffSinceBaseline(
  root: string,
  options: BaselineOptions = {},
  settings: GitSettings = DEFAULT_GIT_SETTINGS,
): Promise<BaselineDiff> {
  const maxDiffBytes = options.maxDiffBytes ?? settings.baselineMaxDiffBytes;

  const status = await runGit(
    root,
    ['status', '--porcelain', '--untracked-files=all'],
    { extraConfig: BASELINE_GIT_CONFIG },
  );
  const { changes, untracked } = parsePorcelain(status.stdout);

  // 快探:变化文件过多时不渲染 unified diff(claude fetchGitDiff 同款),避免拖慢整合。
  if (changes.length > settings.baselineMaxChangesForUnified) {
    return { changes, unifiedDiff: '', truncated: false, unifiedSkipped: true };
  }

  const chunks: string[] = [];

  // tracked 变化(modified / deleted / staged added / rename):一次 git diff HEAD 取回
  const trackedPaths = changes.filter((c) => !untracked.includes(c.path));
  if (trackedPaths.length > 0) {
    const tracked = await runGit(
      root,
      ['diff', 'HEAD', '--no-color', '--no-textconv', '--no-ext-diff', '--no-renames'],
      {
        maxOutputBytes: Math.max(maxDiffBytes * 2, 8 * 1024 * 1024),
        extraConfig: BASELINE_GIT_CONFIG,
      },
    );
    if (tracked.stdout.trim()) chunks.push(tracked.stdout);
  }

  // untracked 新增:复用 diff.ts 的成熟实现(内部已处理 NUL 设备与 8MB buffer),批并发 + 失败容错。
  // overrides 传空数组:filter driver 只存在于用户仓库的 .gitattributes,memory-workspace 是受控内部目录,不需要 filterDriverOverrides 防护。
  for (let i = 0; i < untracked.length; i += settings.untrackedDiffConcurrency) {
    const batch = untracked.slice(i, i + settings.untrackedDiffConcurrency);
    const patches = await Promise.all(
      batch.map((file) =>
        diffUntrackedFile(root, [], file, settings).catch((error: unknown) => {
          // 伪 diff 期间文件被删等竞态:忽略该文件,不中断整体 diff
          if (error instanceof GitError) return null;
          throw error;
        }),
      ),
    );
    for (const patch of patches) {
      if (patch) chunks.push(patch);
    }
  }

  const raw = chunks.join('');
  const truncated = Buffer.byteLength(raw, 'utf8') > maxDiffBytes;
  return {
    changes,
    unifiedDiff: truncated ? truncateAtCharBoundary(raw, maxDiffBytes) : raw,
    truncated,
    unifiedSkipped: false,
  };
}

// ── 解析 ─────────────────────────────────────────────────────────────────────

interface PorcelainResult {
  changes: BaselineChange[];
  /** porcelain 中 "??" 开头的未跟踪文件(相对路径,展开到文件级)。 */
  untracked: string[];
}

function parsePorcelain(stdout: string): PorcelainResult {
  const changes: BaselineChange[] = [];
  const untracked: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('?? ')) {
      const file = line.slice(3).trim();
      if (!file) continue;
      changes.push({ status: 'added', path: file });
      untracked.push(file);
      continue;
    }
    const x = line[0] as string;
    const y = line[1] as string;
    const rest = line.slice(3).trim();
    if (!rest) continue;

    if (x === 'R' || y === 'R' || x === 'C' || y === 'C') {
      // "R100 old\tnew"。拆成 deleted + added 双状态而非单一 renamed:
      // 与 tracked 侧 --no-renames 的 diff 表达保持一致,防 rename 检测差异导致漏计数。
      const [oldPath, newPath] = rest.split('\t');
      changes.push({ status: 'deleted', path: oldPath ?? rest });
      if (newPath) changes.push({ status: 'added', path: newPath });
      continue;
    }

    const status = porcelainStatus(x, y);
    if (status) changes.push({ status, path: rest });
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return { changes, untracked };
}

function porcelainStatus(x: string, y: string): BaselineChangeStatus | null {
  const codes = x + y;
  if (codes.includes('A')) return 'added';
  if (codes.includes('M')) return 'modified';
  if (codes.includes('D')) return 'deleted';
  return null;
}

/** 按 UTF-8 字符边界截断,不切半字符(codex previous_char_boundary 同款)。 */
function truncateAtCharBoundary(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let slice = text;
  while (Buffer.byteLength(slice, 'utf8') > maxBytes) {
    slice = slice.slice(0, -1);
  }
  return slice;
}
