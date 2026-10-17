import { findRepoRoot } from './repoDetection.js';
import { toGitQueryFailure } from './errors.js';
import { queryBranch } from './queries/branch.js';
import { queryBranches } from './queries/branches.js';
import { queryRecentCommits } from './queries/commits.js';
import type { GitRefsResult } from './types.js';

export async function gitRefs(cwd: string): Promise<GitRefsResult> {
  const repoRoot = await findRepoRoot(cwd);
  if (!repoRoot) return { status: 'not-a-repo' };

  try {
    const [branchInfo, branches, commits] = await Promise.all([
      queryBranch(repoRoot),
      queryBranches(repoRoot),
      queryRecentCommits(repoRoot),
    ]);
    return {
      current: branchInfo.branch,
      branches,
      commits,
    };
  } catch (error) {
    return toGitQueryFailure(error);
  }
}
