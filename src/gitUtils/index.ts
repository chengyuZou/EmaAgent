// Git 只读能力的公共出口:对外只有 gitSummary/gitWorkspaceDiff、类型与错误,查询与进程细节不穿透。
export { gitSummary } from './summary.js';
export { gitWorkspaceDiff } from './diff.js';
export { GitError } from './errors.js';
export type { GitErrorCode } from './errors.js';
export type {
  GitSummary,
  GitSummaryOk,
  GitChangeStats,
  GitWorkspaceDiffResult,
  GitDiffOk,
  GitScopeDiff,
  GitDiffFile,
  GitFileStatus,
} from './types.js';
