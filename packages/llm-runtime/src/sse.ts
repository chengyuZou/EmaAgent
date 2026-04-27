/**
 * Server-Sent Events 解析器。
 *
 * OpenAI Responses API 和 Anthropic Messages API 都使用 SSE，但事件名、data JSON
 * 结构不同。这里按 SSE 标准只解析 wire format：event/data/id/retry。provider adapter
 * 再决定如何解释 data。
 */

export interface SseMessage {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

/** 从 fetch Response.body 中逐条解析 SSE message。 */
export async function* readSseMessages(body: ReadableStream<Uint8Array> | null): AsyncIterable<SseMessage> {
  if (!body) {
    throw new Error("SSE response does not contain a readable body.");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  let eventId: string | undefined;
  let retry: number | undefined;
  let dataLines: string[] = [];

  const resetEvent = (): void => {
    eventName = undefined;
    eventId = undefined;
    retry = undefined;
    dataLines = [];
  };

  const dispatch = (): SseMessage | undefined => {
    if (dataLines.length === 0) {
      resetEvent();
      return undefined;
    }

    const message: SseMessage = {
      data: dataLines.join("\n"),
      event: eventName,
      id: eventId,
      retry,
    };
    resetEvent();
    return message;
  };

  const handleLine = (rawLine: string): SseMessage | undefined => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      return dispatch();
    }
    if (line.startsWith(":")) {
      return undefined;
    }

    const separatorIndex = line.indexOf(":");
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    const value = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1).replace(/^ /u, "");

    if (field === "event") {
      eventName = value;
    } else if (field === "data") {
      dataLines.push(value);
    } else if (field === "id") {
      eventId = value;
    } else if (field === "retry") {
      const parsedRetry = Number.parseInt(value, 10);
      retry = Number.isFinite(parsedRetry) ? parsedRetry : undefined;
    }

    return undefined;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (buffer.length > 0) {
          const message = handleLine(buffer);
          if (message) {
            yield message;
          }
        }
        const trailingMessage = dispatch();
        if (trailingMessage) {
          yield trailingMessage;
        }
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const message = handleLine(line);
        if (message) {
          yield message;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** SSE data 的 JSON 安全解析；`[DONE]` 或非法 JSON 返回 undefined。 */
export function parseSseJsonData(data: string): unknown {
  if (data.trim() === "[DONE]") {
    return undefined;
  }
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}
