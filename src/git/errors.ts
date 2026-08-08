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
