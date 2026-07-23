// 读取当前 Session 的持久 Task 快照，Task 修改继续由根 Turn 的工具完成。
import type { SessionId, TaskId } from '@ema-agent/ids';
import type { TaskSnapshot } from '@ema-agent/tasks';
import { sidecarClient } from './sidecar-client.js';

export const tasksApi = {
  list(sessionId: SessionId): Promise<{ tasks: TaskSnapshot[] }> {
    const params = new URLSearchParams({ sessionId: sessionId as string });
    return sidecarClient.request(`/api/tasks?${params.toString()}`);
  },

  get(sessionId: SessionId, taskId: TaskId): Promise<{ task: TaskSnapshot }> {
    const params = new URLSearchParams({ sessionId: sessionId as string });
    return sidecarClient.request(
      `/api/tasks/${encodeURIComponent(taskId as string)}?${params.toString()}`,
    );
  },
};
