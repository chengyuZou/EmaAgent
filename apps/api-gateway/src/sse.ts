import type { EmaStreamEvent } from "@ema-agent/core-types";
import type { SequencedStreamEvent } from "@ema-agent/orchestrator-runtime";

/**
 * SSE 编码工具。
 *
 * 浏览器 EventSource 按空行分隔事件；每个事件写入 id/event/data 三行，
 * 方便前端用 event.type 做分派，同时保留 seq 作为可调试顺序号。
 */
export function encodeSseEvent(input: SequencedStreamEvent): string {
  return [
    `id: ${input.seq}`,
    `data: ${JSON.stringify(input.event)}`,
    "",
    "",
  ].join("\n");
}

/** SSE keep-alive 注释。代理或本地 WebView 长连接空闲时用它保活。 */
export function encodeSseComment(comment: string): string {
  return `: ${comment}\n\n`;
}

/** 开发期 NDJSON 兼容编码。旧 /api/chat 还会临时使用。 */
export function encodeNdjsonEvent(event: EmaStreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}
