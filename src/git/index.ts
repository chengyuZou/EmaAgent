// Git 包的公共出口:只读查询(gitSummary/gitWorkspaceDiff/gitCompareDiff/gitRefs)、
// 基线机制(baseline,内部目录的可重置 diff)、patch 应用(apply);错误与类型不穿透进程细节。
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
  GitDiffTooLarge,
  GitScopeDiff,
  GitDiffFile,
  GitFileStatus,
} from './types.js';


export {
  hasUsableBaseline,
  ensureBaseline,
  resetBaseline,
  compactBaselineStorage,
  diffSinceBaseline,
} from './baseline.js';
export type {
  BaselineChange,
  BaselineChangeStatus,
  BaselineDiff,
  BaselineOptions,
} from './baseline.js';

// ── patch 应用:unified diff → git apply ──
export { applyPatch, extractPathsFromDiff } from './apply.js';
export type { ApplyRequest, ApplyResult } from './apply.js';
