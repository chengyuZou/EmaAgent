// 提供 Session 工作区 Git 只读摘要与工作区 diff 的 HTTP 入口。
import { sidecarClient } from './sidecar-client.js';
import type { GitSummary, GitWorkspaceDiffResult } from '@ema-agent/git-utils';

export type { GitSummary, GitWorkspaceDiffResult };

export const gitApi = {
  /** GET /api/sessions/:id/git-summary — 无工作区的 Session 返回 400,调用方应先确认 workspaceRoot。 */
  getSummary(sessionId: string): Promise<GitSummary> {
    return sidecarClient.request<GitSummary>(`/api/sessions/${sessionId}/git-summary`);
  },

  /** GET /api/sessions/:id/git-diff — 已暂存/未暂存(含未跟踪)双 scope 的按文件 patch。 */
  getWorkspaceDiff(sessionId: string): Promise<GitWorkspaceDiffResult> {
    return sidecarClient.request<GitWorkspaceDiffResult>(`/api/sessions/${sessionId}/git-diff`);
  },
};
