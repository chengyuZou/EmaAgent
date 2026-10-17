import type { GitQueryFailure } from './types.js';

export class GitUnavailableError extends Error {
  constructor() {
    super('git: executable not found on PATH');
    this.name = 'GitUnavailableError';
  }
}

export class GitTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`git ${command}: timed out after ${timeoutMs}ms`);
    this.name = 'GitTimeoutError';
  }
}

export class GitOutputTooLargeError extends Error {
  constructor(command: string, maxOutputBytes: number) {
    super(`git ${command}: output exceeded ${maxOutputBytes} bytes`);
    this.name = 'GitOutputTooLargeError';
  }
}

export class GitDiffTooLargeError extends Error {
  constructor(detail: string) {
    super(`Git diff exceeds the review limit: ${detail}`);
    this.name = 'GitDiffTooLargeError';
  }
}

export class GitCommandError extends Error {
  constructor(command: string, exitCode: number | string, stderr: string) {
    super(`git ${command}: ${stderr.trim() || `exit ${exitCode}`}`);
    this.name = 'GitCommandError';
  }
}

/**
 * diff 查询先处理超限错误, 其余查询将已知的命令错误转为结果.
 * 不认识的错误继续抛出, 避免把代码错误误报为仓库查询失败.
 */
export function toGitQueryFailure(error: unknown): GitQueryFailure {
  if (error instanceof GitUnavailableError) {
    return { status: 'git-unavailable' };
  }
  if (
    error instanceof GitCommandError
    || error instanceof GitTimeoutError
    || error instanceof GitOutputTooLargeError
  ) {
    return { status: 'error', message: error.message };
  }
  throw error;
}
