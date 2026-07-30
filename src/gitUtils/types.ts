// Git 只读摘要对外暴露的稳定类型:capability 判别联合,非 ok 状态不携带任何猜测字段。

/** 单个维度(未暂存/已暂存)的变更统计,解析自 git diff --shortstat。 */
export interface GitChangeStats {
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
}

export interface GitSummaryOk {
  readonly capability: 'ok';
  /** 仓库根目录(.git 所在层),可能与传入的 workspaceRoot 不同。 */
  readonly repoRoot: string;
  /** 当前分支名;detached HEAD 时为 null,由 headShortSha 表达。 */
  readonly branch: string | null;
  readonly headShortSha: string | null;
  readonly unstaged: GitChangeStats;
  readonly staged: GitChangeStats;
  /** 未跟踪文件数(status --porcelain 中 "??" 行)。 */
  readonly untrackedCount: number;
  /** upstream 引用名(如 origin/main);未配置 upstream 为 null,属正常状态。 */
  readonly upstream: string | null;
  /** origin 远端地址;未配置 origin 为 null,属正常状态。 */
  readonly originUrl: string | null;
}

/** 工作区不在任何 Git 仓库内。 */
export interface GitSummaryNotARepo {
  readonly capability: 'not-a-repo';
}

/** 系统找不到 git 可执行文件。 */
export interface GitSummaryUnavailable {
  readonly capability: 'git-unavailable';
}

/** 仓库存在但查询失败(超时、损坏的 .git 等);message 供诊断,不面向用户渲染。 */
export interface GitSummaryError {
  readonly capability: 'error';
  readonly message: string;
}

export type GitSummary =
  | GitSummaryOk
  | GitSummaryNotARepo
  | GitSummaryUnavailable
  | GitSummaryError;

// ── 工作区 diff(批次 E)─────────────────────────────────────────────────────

export type GitFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface GitDiffFile {
  /** 仓库相对 POSIX 路径(展示用)。 */
  readonly path: string;
  /** 打开文件标签用的绝对路径;deleted 文件指向其删除前位置。 */
  readonly absolutePath: string;
  readonly status: GitFileStatus;
  readonly additions: number;
  readonly deletions: number;
  /** 该文件的完整 patch 段(含 diff --git 头);超限截断并以 truncated 标记。 */
  readonly unifiedDiff: string;
  readonly truncated: boolean;
}

export interface GitScopeDiff {
  readonly files: readonly GitDiffFile[];
  readonly totalAdditions: number;
  readonly totalDeletions: number;
  /** 总量或文件数触顶而未包含的文件数;0 表示完整。 */
  readonly omittedFiles: number;
}

export interface GitDiffOk {
  readonly capability: 'ok';
  readonly repoRoot: string;
  /** 已暂存(index ⇄ HEAD)。 */
  readonly staged: GitScopeDiff;
  /** 未暂存(worktree ⇄ index),含未跟踪文件的伪 diff。 */
  readonly unstaged: GitScopeDiff;
}

export type GitWorkspaceDiffResult =
  | GitDiffOk
  | GitSummaryNotARepo
  | GitSummaryUnavailable
  | GitSummaryError;
