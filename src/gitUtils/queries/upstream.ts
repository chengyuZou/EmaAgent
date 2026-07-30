// upstream 引用查询:未配置 upstream 是正常状态,返回 null 而非错误。
import { GitError } from '../errors.js';
import { runGit } from '../gitProcess.js';

export async function queryUpstream(repoRoot: string): Promise<string | null> {
  try {
    const name = (await runGit(
      repoRoot,
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    )).stdout.trim();
    return name || null;
  } catch (error) {
    // 无 upstream 时 git 以非零退出并提示 no upstream configured,按 null 处理。
    if (error instanceof GitError && error.code === 'git/command-failed') return null;
    throw error;
  }
}
