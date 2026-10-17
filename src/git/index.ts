export { gitSummary } from './summary.js';
export { gitWorkspaceDiff, gitCompareDiff } from './diff.js';
export type { GitCompareTarget } from './diff.js';
export { gitRefs } from './refs.js';
export {
  GitCommandError,
  GitDiffTooLargeError,
  GitOutputTooLargeError,
  GitTimeoutError,
  GitUnavailableError,
} from './errors.js';
export type {
  GitSummaryResult,
  GitChangeStats,
  GitWorkspaceDiffResult,
  GitCompareResult,
  GitCommits,
  GitRefsResult,
  GitDiffScope,
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
