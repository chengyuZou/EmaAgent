import { GitCommandError } from '../errors.js';
import { runGit } from '../gitProcess.js';
import type { GitCommits } from '../types.js';

export async function queryRecentCommits(
  repoRoot: string,
  limit = 50,
): Promise<GitCommits> {
  try {
    const { stdout } = await runGit(repoRoot, ['log', `-${limit}`, '--format=%H%x00%s']);
    const commits: GitCommits[number][] = [];
    for (const line of stdout.split('\n')) {
      const sep = line.indexOf('\0');
      if (sep <= 0) continue;
      commits.push({ sha: line.slice(0, sep), subject: line.slice(sep + 1) });
    }
    return commits;
  } catch (error) {
    // 尚无提交时 log 会失败, 允许引用列表返回空提交数组.
    if (error instanceof GitCommandError) return [];
    throw error;
  }
}
