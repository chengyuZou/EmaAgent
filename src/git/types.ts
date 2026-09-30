// Git 只读摘要对外暴露的稳定类型:capability 判别联合,非 ok 状态不携带任何猜测字段。

/** 单个维度(未暂存/已暂存)的变更统计,解析自 git diff --shortstat。 */
export interface GitChangeStats {
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
}

export interface GitSummaryOk {
  readonly capability: 'ok';
  /** 仓库根目录(.git 所在层),可能与传入的 cwd 不同。 */
  readonly repoRoot: string;
  /** 当前分支名;detached HEAD 时为 null,由 headShortSha 表达。 */
  readonly branch: string | null;
  readonly headShortSha: string | null;
  /** 已跟踪文件的暂存区到磁盘统计, 未跟踪文件另外计数. */
  readonly unstaged: GitChangeStats;
  readonly staged: GitChangeStats;
  /** 实际未跟踪文件数, 目录展开到文件级. */
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

// ── 工作区 diff ─────────────────────────────────────────────────────────────

export type GitDiffScope = 'uncommitted' | 'staged' | 'unstaged';

export interface GitDiffOk {
  readonly capability: 'ok';
  readonly repoRoot: string;
  /** 当前范围的原生 Git patch, 不截断或重写内容. */
  readonly patch: string;
  /** 查询期间未能读取的未跟踪文件数, 不包含超限情况. */
  readonly omittedFiles: number;
}

export interface GitDiffTooLarge {
  /** 原始 Git 输出或未跟踪文件数量超出审查查询上限. */
  readonly capability: 'diff-too-large';
}

export type GitWorkspaceDiffResult =
  | GitDiffOk
  | GitDiffTooLarge
  | GitSummaryNotARepo
  | GitSummaryUnavailable
  | GitSummaryError;

// ── 比较 diff 与分支/提交清单 ─────────────────────────────────────────────────

export interface GitCompareOk {
  readonly capability: 'ok';
  readonly repoRoot: string;
  readonly patch: string;
}

export type GitCompareResult =
  | GitCompareOk
  | GitDiffTooLarge
  | GitSummaryNotARepo
  | GitSummaryUnavailable
  | GitSummaryError;

export interface GitRefsOk {
  readonly capability: 'ok';
  /** 当前分支;detached HEAD 为 null。 */
  readonly current: string | null;
  readonly branches: readonly string[];
  readonly commits: readonly { readonly sha: string; readonly subject: string }[];
}

export type GitRefsResult =
  | GitRefsOk
  | GitSummaryNotARepo
  | GitSummaryUnavailable
  | GitSummaryError;
