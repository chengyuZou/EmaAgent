// Git 只读能力的公共出口:对外只有 gitSummary/gitWorkspaceDiff/gitCompareDiff/gitRefs、类型与错误,查询与进程细节不穿透。
export { gitSummary } from './summary.js';
export { gitWorkspaceDiff, gitCompareDiff } from './diff.js';
export type { GitCompareTarget } from './diff.js';
export { gitRefs } from './refs.js';
export { GitError } from './errors.js';
export type { GitErrorCode } from './errors.js';
export type {
  GitSummary,
  GitSummaryOk,
  GitChangeStats,
  GitWorkspaceDiffResult,
  GitCompareResult,
  GitRefsResult,
  GitDiffOk,
  GitScopeDiff,
  GitDiffFile,
  GitFileStatus,
} from './types.js';
