// 提供 Session 工作区 Git 只读摘要的 HTTP 入口。
import { sidecarClient } from './sidecar-client.js';
import type { GitSummary } from '@ema-agent/git-utils';

export type { GitSummary };

export const gitApi = {
  /** GET /api/sessions/:id/git-summary — 无工作区的 Session 返回 400,调用方应先确认 workspaceRoot。 */
  getSummary(sessionId: string): Promise<GitSummary> {
    return sidecarClient.request<GitSummary>(`/api/sessions/${sessionId}/git-summary`);
  },
};
