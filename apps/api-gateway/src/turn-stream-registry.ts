import type { EmaStreamEvent } from "@ema-agent/core-types";

/** 注册表中的单个 turn stream。 */
interface RegisteredTurnStream {
  requestId: string;
  sessionId: string;
  acceptedAt: number;
  stream: AsyncIterable<EmaStreamEvent>;
  consumed: boolean;
}

/** in-memory turn stream 注册表。V1 本地桌面先用内存，后续可换成持久任务队列。 */
const turnStreams = new Map<string, RegisteredTurnStream>();

/** 注册新 turn 的事件流，供 GET /api/turns/:id/stream 消费。 */
export function registerTurnStream(input: {
  requestId: string;
  sessionId: string;
  acceptedAt: number;
  stream: AsyncIterable<EmaStreamEvent>;
}): void {
  turnStreams.set(input.requestId, {
    ...input,
    consumed: false,
  });
}

/** 获取并标记一个 stream 已被消费。EventSource 重连时暂不支持重复消费。 */
export function consumeTurnStream(requestId: string): RegisteredTurnStream | null {
  const entry = turnStreams.get(requestId);
  if (!entry || entry.consumed) {
    return null;
  }

  entry.consumed = true;
  return entry;
}

/** 清理 turn stream，避免本地长时间运行时泄漏内存。 */
export function removeTurnStream(requestId: string): void {
  turnStreams.delete(requestId);
}
