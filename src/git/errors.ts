export type GitErrorCode =
  | 'git/unavailable'
  | 'git/timeout'
  | 'git/command-failed';

export class GitError extends Error {
  constructor(
    readonly code: GitErrorCode,
    message: string,
    readonly stderr?: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * 把 runGit 抛出的错误映射成 capability 判别联合的失败分支。
 * 非 GitError(编程错误等)直接重抛,不吞;调用方 pattern:
 *
 *   try { ... } catch (error) {
 *     return mapGitError(error, (kind, message) =>
 *       kind === 'unavailable'
 *         ? { capability: 'git-unavailable' }
 *         : { capability: 'error', message });
 *   }
 *
 * 结果由回调构造,让 TS 推断出精确的字面量联合(而不是拓宽成 string)。
 * 这是 summary / refs / diff 共同的错误映射,抽出来避免四处重复。
 */
export function mapGitError<TOk extends { capability: string }>(
  error: unknown,
  makeResult: (kind: 'unavailable' | 'error', message: string) => TOk,
): TOk {
  if (error instanceof GitError) {
    if (error.code === 'git/unavailable') return makeResult('unavailable', '');
    return makeResult('error', error.stderr ?? error.message);
  }
  throw error;
}
