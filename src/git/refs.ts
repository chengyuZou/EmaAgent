// gitRefs:分支列表 + 最近提交 + 当前分支的一次性组装,供比较范围选择器。
import { GitError } from './errors.js';
import { findRepoRoot } from './repoDetection.js';
import { queryBranch } from './queries/branch.js';
import { queryBranches } from './queries/branches.js';
import { queryRecentCommits } from './queries/commits.js';
import type { GitRefsResult } from './types.js';

export async function gitRefs(workspaceRoot: string): Promise<GitRefsResult> {
  const repoRoot = await findRepoRoot(workspaceRoot);
  if (!repoRoot) return { capability: 'not-a-repo' };

  try {
    const [branchInfo, branches, commits] = await Promise.all([
      queryBranch(repoRoot),
      queryBranches(repoRoot),
      queryRecentCommits(repoRoot),
    ]);
    return {
      capability: 'ok',
      current: branchInfo.branch,
      branches,
      commits,
    };
  } catch (error) {
    if (error instanceof GitError) {
      if (error.code === 'git/unavailable') return { capability: 'git-unavailable' };
      return { capability: 'error', message: error.stderr ?? error.message };
    }
    throw error;
  }
}
