// 当前分支查询:正常分支给名字,detached HEAD 退回短 SHA,空仓库两者皆为 null。
import { GitError } from '../errors.js';
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
    // 空仓库(尚无任何提交)rev-parse HEAD 必失败,属正常状态而非查询错误。
    if (error instanceof GitError && error.code === 'git/command-failed') {
      return { branch: null, headShortSha: null };
    }
    throw error;
  }
}
