import { GitCommandError } from '../errors.js';
import { runGit } from '../gitProcess.js';

export async function queryOriginUrl(repoRoot: string): Promise<string | null> {
  try {
    const url = (await runGit(repoRoot, ['remote', 'get-url', 'origin'])).stdout.trim();
    return url || null;
  } catch (error) {
    // 未配置 origin 也会非零退出, 查询结果用 null 表示地址不可用.
    if (error instanceof GitCommandError) return null;
    throw error;
  }
}
