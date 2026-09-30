// Git 自己展开未跟踪目录, NUL 分隔保留空格、引号和换行路径.
import { runGit } from '../gitProcess.js';

export async function listUntrackedFiles(
  repoRoot: string,
  extraConfig: readonly string[] = [],
): Promise<string[]> {
  const { stdout } = await runGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'], {
    extraConfig,
  });
  return stdout.split('\0').filter(file => file.length > 0);
}
