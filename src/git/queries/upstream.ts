import { GitCommandError } from '../errors.js';
import { runGit } from '../gitProcess.js';

export async function queryUpstream(repoRoot: string): Promise<string | null> {
  try {
    const name = (await runGit(
      repoRoot,
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    )).stdout.trim();
    return name || null;
  } catch (error) {
    // 未配置 upstream 也会非零退出, 查询结果用 null 表示引用不可用.
    if (error instanceof GitCommandError) return null;
    throw error;
  }
}
