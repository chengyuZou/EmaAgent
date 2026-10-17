import { runGit } from '../gitProcess.js';

export async function queryBranches(repoRoot: string): Promise<string[]> {
  const { stdout } = await runGit(repoRoot, [
    'for-each-ref', '--format=%(refname:short)', 'refs/heads',
  ]);
  return stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}
