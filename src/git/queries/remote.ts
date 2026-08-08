// origin 远端地址查询:未配置 origin 是正常状态,返回 null 而非错误。
import { GitError } from '../errors.js';
import { runGit } from '../gitProcess.js';

export async function queryOriginUrl(repoRoot: string): Promise<string | null> {
  try {
    const url = (await runGit(repoRoot, ['remote', 'get-url', 'origin'])).stdout.trim();
    return url || null;
  } catch (error) {
    // 无 origin remote 时 git 以非零退出,按 null 处理。
    if (error instanceof GitError && error.code === 'git/command-failed') return null;
    throw error;
  }
}
