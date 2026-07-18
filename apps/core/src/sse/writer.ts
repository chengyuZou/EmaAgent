// 把结构化事件和服务端游标编码成标准 SSE 帧。

import type { EmaStreamEvent } from '@ema-agent/contracts';

/** 编码一条业务事件；Turn SSE 传 cursor，系统 SSE 可以省略。 */
export function encodeEvent(event: EmaStreamEvent, cursor?: number): string {
  const id = cursor === undefined ? '' : `id: ${cursor}\n`;
  return `${id}data: ${JSON.stringify(event)}\n\n`;
}

/**
 * 心跳不是 EmaStreamEvent，不进入重放日志，只用于维持连接和发现断线。
 */
export function encodePing(): string {
  return 'event: heartbeat\ndata: {}\n\n';
}
