import { runGit } from '../gitProcess.js';

export async function listUntrackedFiles(
  repoRoot: string,
  extraConfig: readonly string[] = [],
): Promise<string[]> {
  const { stdout } = await runGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'], {
    extraConfig,
  });
  // 用 NUL 分隔且不 trim, 保留文件名中的前导空格, 引号和换行.
  return stdout.split('\0').filter(file => file.length > 0);
}
