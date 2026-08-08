// 未暂存/已暂存变更统计:解析 git diff --shortstat 的单行汇总。
import { runGit } from '../gitProcess.js';
import type { GitChangeStats } from '../types.js';

export async function queryChangeStats(
  repoRoot: string,
  scope: 'unstaged' | 'staged',
): Promise<GitChangeStats> {
  const args = scope === 'staged'
    ? ['diff', '--cached', '--shortstat']
    : ['diff', '--shortstat'];
  const { stdout } = await runGit(repoRoot, args);
  return parseShortStat(stdout);
}

/**
 * shortstat 形如 " 3 files changed, 10 insertions(+), 2 deletions(-)",
 * 三个部分都可能缺省(无变更时整行为空);单数形式没有 s。
 */
export function parseShortStat(output: string): GitChangeStats {
  return {
    filesChanged: matchCount(output, /(\d+) files? changed/) ?? 0,
    insertions: matchCount(output, /(\d+) insertions?\(\+\)/) ?? 0,
    deletions: matchCount(output, /(\d+) deletions?\(-\)/) ?? 0,
  };
}

function matchCount(output: string, pattern: RegExp): number | null {
  const match = pattern.exec(output);
  return match?.[1] === undefined ? null : Number(match[1]);
}
