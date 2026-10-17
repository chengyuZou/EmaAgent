import { GitCommandError } from '../errors.js';
import { runGit } from '../gitProcess.js';

export interface BranchInfo {
  readonly branch: string | null;
  readonly headShortSha: string | null;
}

export async function queryBranch(repoRoot: string): Promise<BranchInfo> {
  const branch = (await runGit(repoRoot, ['branch', '--show-current'])).stdout.trim();
  if (branch) return { branch, headShortSha: null };
  try {
    const sha = (await runGit(repoRoot, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
    return { branch: null, headShortSha: sha || null };
  } catch (error) {
    // 尚无提交时 HEAD 无法解析, 允许返回没有短 SHA 的结果.
    if (error instanceof GitCommandError) {
      return { branch: null, headShortSha: null };
    }
    throw error;
  }
}
