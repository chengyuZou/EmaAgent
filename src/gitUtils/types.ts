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
