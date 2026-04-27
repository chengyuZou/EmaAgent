import type { ChatCompletionRequest } from "@ema-agent/core-types";
import { describe, expect, it } from "vitest";
import type { RuntimeFetch } from "../types.js";
import { OpenAINativeProvider } from "./openai-native.js";

describe("OpenAINativeProvider", () => {
  it("maps unified chat requests to OpenAI Responses payload", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const provider = new OpenAINativeProvider({
      apiKey: "test-key",
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ output_text: "你好，收到。", usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 } });
      },
    });

    const text = await provider.chat(baseRequest({
      tools: [
        {
          name: "read_file",
          description: "读取工作区文件",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      ],
    }));

    const input = capturedBody?.input as Array<Record<string, unknown>>;
    const tools = capturedBody?.tools as Array<Record<string, unknown>>;

    expect(text).toBe("你好，收到。");
    expect(capturedBody?.model).toBe("gpt-5.2");
    expect(capturedBody?.stream).toBe(false);
    expect(capturedBody?.max_output_tokens).toBe(1024);
    expect(capturedBody?.store).toBe(false);
    expect(input[0]).toEqual({ role: "system", content: "你是 Ema。" });
    expect(input[1]).toEqual({ role: "user", content: "帮我整理任务。" });
    expect(tools[0].type).toBe("function");
    expect(tools[0].name).toBe("read_file");
  });

  it("normalizes OpenAI typed streaming events into chunks", async () => {
    const provider = new OpenAINativeProvider({
      apiKey: "test-key",
      fetch: sseFetch([
        sseData({ type: "response.output_text.delta", output_index: 0, delta: "你" }),
        sseData({ type: "response.output_text.delta", output_index: 0, delta: "好" }),
        sseData({
          type: "response.completed",
          response: { usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } },
        }),
        "data: [DONE]\n\n",
      ].join("")),
    });

    const chunks = [];
    for await (const chunk of provider.chatStream(baseRequest())) {
      chunks.push(chunk);
    }

    expect(chunks.map(chunk => chunk.delta.content).filter(Boolean)).toEqual(["你", "好"]);
    expect(chunks.at(-1)).toMatchObject({
      finishReason: "stop",
      usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
    });
  });
});

function baseRequest(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    sessionId: "session-1",
    modelId: "gpt-5.2",
    messages: [
      { role: "system", content: "你是 Ema。" },
      { role: "user", content: "帮我整理任务。" },
    ],
    maxTokens: 1024,
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sseFetch(text: string): RuntimeFetch {
  return async () => new Response(streamFromText(text), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function sseData(body: unknown): string {
  return `data: ${JSON.stringify(body)}\n\n`;
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}
