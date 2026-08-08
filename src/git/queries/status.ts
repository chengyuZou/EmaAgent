// 未跟踪文件计数:porcelain 输出中 "??" 前缀的行数。
import { runGit } from '../gitProcess.js';

export async function queryUntrackedCount(repoRoot: string): Promise<number> {
  const { stdout } = await runGit(repoRoot, ['status', '--porcelain', '--untracked-files=normal']);
  return countUntracked(stdout);
}

export function countUntracked(porcelain: string): number {
  let count = 0;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('?? ')) count += 1;
  }
  return count;
}
