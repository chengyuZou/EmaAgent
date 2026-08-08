// 本地分支列表查询:for-each-ref 只读,空仓库返回空数组。
import { runGit } from '../gitProcess.js';

export async function queryBranches(repoRoot: string): Promise<string[]> {
  const { stdout } = await runGit(repoRoot, [
    'for-each-ref', '--format=%(refname:short)', 'refs/heads',
  ]);
  return stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}
