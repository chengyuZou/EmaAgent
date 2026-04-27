import type { ChatCompletionRequest } from "@ema-agent/core-types";
import { describe, expect, it } from "vitest";
import type { RuntimeFetch } from "../types.js";
import { AnthropicNativeProvider } from "./anthropic-native.js";

describe("AnthropicNativeProvider", () => {
  it("maps unified chat requests to Anthropic Messages payload", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const provider = new AnthropicNativeProvider({
      apiKey: "test-key",
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          content: [{ type: "text", text: "收到，我来处理。" }],
          usage: { input_tokens: 4, output_tokens: 6 },
          stop_reason: "end_turn",
        });
      },
    });

    const text = await provider.chat(baseRequest({
      tools: [
        {
          name: "write_file",
          description: "写入工作区文件",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      ],
    }));

    const messages = capturedBody?.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const tools = capturedBody?.tools as Array<Record<string, unknown>>;

    expect(text).toBe("收到，我来处理。");
    expect(capturedBody?.model).toBe("claude-sonnet-4-20250514");
    expect(capturedBody?.system).toBe("你是 Ema。");
    expect(capturedBody?.stream).toBe(false);
    expect(capturedBody?.max_tokens).toBe(1024);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content[0]).toEqual({ type: "text", text: "帮我整理任务。" });
    expect(tools[0].name).toBe("write_file");
    expect(tools[0].input_schema).toEqual({ type: "object", properties: { path: { type: "string" } }, required: ["path"] });
  });

  it("normalizes Anthropic streaming text, tool args, stop reason, and usage", async () => {
    const provider = new AnthropicNativeProvider({
      apiKey: "test-key",
      fetch: sseFetch([
        sseEvent("message_start", {
          type: "message_start",
          message: { usage: { input_tokens: 7, output_tokens: 1 } },
        }),
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "好" },
        }),
        sseEvent("content_block_start", {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} },
        }),
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: "{\"path\":\"README.md\"}" },
        }),
        sseEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 9 },
        }),
        sseEvent("message_stop", { type: "message_stop" }),
      ].join("")),
    });

    const chunks = [];
    for await (const chunk of provider.chatStream(baseRequest())) {
      chunks.push(chunk);
    }

    expect(chunks[0].delta.content).toBe("好");
    expect(chunks[1].toolCalls).toEqual([
      { id: "toolu_1", toolName: "read_file", argumentsDelta: "{\"path\":\"README.md\"}" },
    ]);
    expect(chunks.at(-1)).toMatchObject({
      finishReason: "tool_calls",
      usage: { inputTokens: 7, outputTokens: 9, totalTokens: 16 },
    });
  });
});

function baseRequest(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    sessionId: "session-1",
    modelId: "claude-sonnet-4-20250514",
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

function sseEvent(event: string, body: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(body)}\n\n`;
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
