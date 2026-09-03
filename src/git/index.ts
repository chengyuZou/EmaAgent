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
  GitScopeDiff,
  GitDiffFile,
  GitFileStatus,
} from './types.js';


// ── 基线机制:内部目录的可重置 diff(单 commit 基线,对照 codex git-utils baseline.rs) ──
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

// ── patch 应用:unified diff → git apply(对照 codex git-utils apply.rs) ──
export { applyPatch, extractPathsFromDiff } from './apply.js';
export type { ApplyRequest, ApplyResult } from './apply.js';
