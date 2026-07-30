// gitSummary:能力裁决 → 并行只读查询 → 组装对外摘要;任何失败都归入明确 capability,不抛出。
import { GitError } from './errors.js';
import { findRepoRoot } from './repoDetection.js';
import { queryBranch } from './queries/branch.js';
import { queryChangeStats } from './queries/changeStats.js';
import { queryUntrackedCount } from './queries/status.js';
import { queryUpstream } from './queries/upstream.js';
import type { GitSummary } from './types.js';

export async function gitSummary(workspaceRoot: string): Promise<GitSummary> {
  const repoRoot = await findRepoRoot(workspaceRoot);
  if (!repoRoot) return { capability: 'not-a-repo' };

  try {
    // 与 codex collect_git_info 同时序:先确认仓库,再并行全部只读查询。
    const [branchInfo, unstaged, staged, untrackedCount, upstream] = await Promise.all([
      queryBranch(repoRoot),
      queryChangeStats(repoRoot, 'unstaged'),
      queryChangeStats(repoRoot, 'staged'),
      queryUntrackedCount(repoRoot),
      queryUpstream(repoRoot),
    ]);
    return {
      capability: 'ok',
      repoRoot,
      ...branchInfo,
      unstaged,
      staged,
      untrackedCount,
      upstream,
    };
  } catch (error) {
    if (error instanceof GitError) {
      if (error.code === 'git/unavailable') return { capability: 'git-unavailable' };
      return { capability: 'error', message: error.stderr ?? error.message };
    }
    throw error;
  }
}
