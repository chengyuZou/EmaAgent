// 最近提交查询:sha + 标题,供"提交记录"比较选择器;空仓库返回空数组。
import { GitError } from '../errors.js';
import { runGit } from '../gitProcess.js';

export interface GitCommitEntry {
  readonly sha: string;
  readonly subject: string;
}

export async function queryRecentCommits(
  repoRoot: string,
  limit = 50,
): Promise<readonly GitCommitEntry[]> {
  try {
    const { stdout } = await runGit(repoRoot, ['log', `-${limit}`, '--format=%H%x00%s']);
    const commits: GitCommitEntry[] = [];
    for (const line of stdout.split('\n')) {
      const sep = line.indexOf('\0');
      if (sep <= 0) continue;
      commits.push({ sha: line.slice(0, sep), subject: line.slice(sep + 1) });
    }
    return commits;
  } catch (error) {
    // 空仓库(尚无任何提交)log 必失败,属正常状态而非查询错误。
    if (error instanceof GitError && error.code === 'git/command-failed') return [];
    throw error;
  }
}
