// 提供后台进程列表、增量输出与停止的 HTTP 入口;wire 类型直接复用 @ema-agent/tools。
import { sidecarClient } from './sidecar-client.js';
import type {
  BackgroundProcessOutput,
  BackgroundProcessStatus,
  BackgroundProcessSummary,
} from '@ema-agent/tools';

export type { BackgroundProcessOutput, BackgroundProcessStatus, BackgroundProcessSummary };

export const backgroundProcessesApi = {
  /** GET /api/background-processes?sessionId&status?&limit — Session 隔离列表。 */
  list(
    sessionId: string,
    opts: { status?: BackgroundProcessStatus; limit?: number } = {},
  ): Promise<{ processes: BackgroundProcessSummary[] }> {
    const params = new URLSearchParams({ sessionId });
    if (opts.status) params.set('status', opts.status);
    if (opts.limit) params.set('limit', String(opts.limit));
    return sidecarClient.request(`/api/background-processes?${params.toString()}`);
  },

  /** GET /:id/output — 游标前向翻页;waitMs>0 且进程存活时长轮询。 */
  readOutput(
    sessionId: string,
    backgroundProcessId: string,
    opts: { cursor?: string; waitMs?: number } = {},
  ): Promise<BackgroundProcessOutput> {
    const params = new URLSearchParams({ sessionId });
    if (opts.cursor) params.set('cursor', opts.cursor);
    if (opts.waitMs) params.set('waitMs', String(opts.waitMs));
    return sidecarClient.request(
      `/api/background-processes/${backgroundProcessId}/output?${params.toString()}`,
    );
  },

  /** POST /:id/stop — 只提交 backgroundProcessId,不提交 PID。 */
  stop(sessionId: string, backgroundProcessId: string): Promise<{ process: BackgroundProcessSummary }> {
    return sidecarClient.request(`/api/background-processes/${backgroundProcessId}/stop`, {
      method: 'POST',
      json: { sessionId },
    });
  },
};
