// 提供 Session 工作区 Git 只读摘要、工作区 diff 与比较查询的 HTTP 入口。
import { sidecarClient } from './sidecar-client.js';
import type { GitCompareResult, GitRefsResult, GitSummary, GitWorkspaceDiffResult } from '@ema-agent/git-utils';

export type { GitCompareResult, GitRefsResult, GitSummary, GitWorkspaceDiffResult };

export const gitApi = {
  /** GET /api/sessions/:id/git-summary — 无工作区的 Session 返回 400,调用方应先确认 workspaceRoot。 */
  getSummary(sessionId: string): Promise<GitSummary> {
    return sidecarClient.request<GitSummary>(`/api/sessions/${sessionId}/git-summary`);
  },

  /** GET /api/sessions/:id/git-diff — 已暂存/未暂存(含未跟踪)双 scope 的按文件 patch。 */
  getWorkspaceDiff(sessionId: string): Promise<GitWorkspaceDiffResult> {
    return sidecarClient.request<GitWorkspaceDiffResult>(`/api/sessions/${sessionId}/git-diff`);
  },

  /** GET /api/sessions/:id/git-refs — 当前分支、本地分支列表与最近提交。 */
  getRefs(sessionId: string): Promise<GitRefsResult> {
    return sidecarClient.request<GitRefsResult>(`/api/sessions/${sessionId}/git-refs`);
  },

  /** GET /api/sessions/:id/git-compare — commit=该提交补丁;branch=merge-base 后全部变更。 */
  getCompare(
    sessionId: string,
    target: { type: 'commit'; ref: string } | { type: 'branch'; ref: string },
  ): Promise<GitCompareResult> {
    const params = new URLSearchParams({ type: target.type, ref: target.ref });
    return sidecarClient.request<GitCompareResult>(
      `/api/sessions/${sessionId}/git-compare?${params.toString()}`,
    );
  },
};
