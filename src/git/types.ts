export interface GitChangeStats {
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
}

export type GitQueryFailure =
  | { readonly status: 'not-a-repo' }
  | { readonly status: 'git-unavailable' }
  | {
      readonly status: 'error';
      /** Git 命令错误信息, 桌面界面按 status 显示失败提示. */
      readonly message: string;
    };

export type GitSummaryResult =
  | {
      /** .git 所在的目录, 传入仓库子目录时会与 cwd 不同. */
      readonly repoRoot: string;
      /** detached HEAD 时为 null, 改用 headShortSha 表示当前提交. */
      readonly branch: string | null;
      /** 仅在没有分支名时查询, HEAD 无法解析时也为 null. */
      readonly headShortSha: string | null;
      /** 已跟踪文件的暂存区到磁盘统计, 未跟踪文件另外计数. */
      readonly unstaged: GitChangeStats;
      readonly staged: GitChangeStats;
      /** 实际未跟踪文件数, 目录展开到文件级. */
      readonly untrackedCount: number;
      /** 例如 origin/main, 查询不到时为 null. */
      readonly upstream: string | null;
      /** origin 的地址, 查询不到时为 null. */
      readonly originUrl: string | null;
    }
  | GitQueryFailure;

export type GitDiffScope = 'uncommitted' | 'staged' | 'unstaged';

export type GitWorkspaceDiffResult =
  | {
      readonly repoRoot: string;
      /** 当前范围的原生 Git patch, 不截断或重写内容. */
      readonly patch: string;
      /** 查询期间未能读取的未跟踪文件数, 不包含超限情况. */
      readonly omittedFiles: number;
    }
  | { readonly status: 'diff-too-large' }
  | GitQueryFailure;

export type GitCompareResult =
  | {
      readonly repoRoot: string;
      readonly patch: string;
    }
  | { readonly status: 'diff-too-large' }
  | GitQueryFailure;

export type GitCommits = readonly {
  readonly sha: string;
  readonly subject: string;
}[];

export type GitRefsResult =
  | {
      /** detached HEAD 时为 null. */
      readonly current: string | null;
      /** 本地分支名, 来自 refs/heads. */
      readonly branches: readonly string[];
      /** 从当前 HEAD 开始的最近 50 条提交, sha 为完整提交 ID. */
      readonly commits: GitCommits;
    }
  | GitQueryFailure;
