import { findRepoRoot } from './repoDetection.js';
import { toGitQueryFailure } from './errors.js';
import { queryBranch } from './queries/branch.js';
import { queryChangeStats } from './queries/changeStats.js';
import { listUntrackedFiles } from './queries/status.js';
import { queryUpstream } from './queries/upstream.js';
import { queryOriginUrl } from './queries/remote.js';
import type { GitSummaryResult } from './types.js';

export async function gitSummary(cwd: string): Promise<GitSummaryResult> {
  const repoRoot = await findRepoRoot(cwd);
  if (!repoRoot) return { status: 'not-a-repo' };

  try {
    const [branchInfo, unstaged, staged, untracked, upstream, originUrl] = await Promise.all([
      queryBranch(repoRoot),
      queryChangeStats(repoRoot, 'unstaged'),
      queryChangeStats(repoRoot, 'staged'),
      listUntrackedFiles(repoRoot),
      queryUpstream(repoRoot),
      queryOriginUrl(repoRoot),
    ]);
    return {
      repoRoot,
      ...branchInfo,
      unstaged,
      staged,
      untrackedCount: untracked.length,
      upstream,
      originUrl,
    };
  } catch (error) {
    return toGitQueryFailure(error);
  }
}
