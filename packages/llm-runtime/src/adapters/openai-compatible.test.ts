import type { ChatCompletionRequest } from "@ema-agent/core-types";
import { describe, expect, it } from "vitest";
import type { RuntimeFetch } from "../types.js";
import { DeepSeekCompatibleProvider, OllamaCompatibleProvider, OpenRouterCompatibleProvider } from "./openai-compatible.js";

describe("OpenAI-compatible providers", () => {
  it("maps requests to /chat/completions payload for DeepSeek", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    const provider = new DeepSeekCompatibleProvider({
      apiKey: "test-key",
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedHeaders = init?.headers as Record<string, string>;
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          choices: [{ message: { content: "收到。" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        });
      },
    });

    const text = await provider.chat(baseRequest({
      modelId: "deepseek-chat",
      tools: [
        {
          name: "read_file",
          description: "读取文件",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      ],
    }));

    const messages = capturedBody?.messages as Array<Record<string, unknown>>;
    const tools = capturedBody?.tools as Array<{ function: Record<string, unknown> }>;

    expect(text).toBe("收到。");
    expect(capturedUrl).toBe("https://api.deepseek.com/chat/completions");
    expect(capturedHeaders?.authorization).toBe("Bearer test-key");
    expect(capturedBody?.model).toBe("deepseek-chat");
    expect(messages[0]).toEqual({ role: "system", content: "你是 Ema。" });
    expect(tools[0].function.name).toBe("read_file");
  });

  it("normalizes streaming text, tool calls, finish reason, and usage", async () => {
    const provider = new OpenRouterCompatibleProvider({
      apiKey: "test-key",
      fetch: sseFetch([
        sseData({ choices: [{ index: 0, delta: { content: "好" } }] }),
        sseData({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\"" } },
                ],
              },
            },
          ],
        }),
        sseData({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: ":\"README.md\"}" } }] },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
        }),
        "data: [DONE]\n\n",
      ].join("")),
    });

    const chunks = [];
    for await (const chunk of provider.chatStream(baseRequest({ modelId: "openrouter/auto" }))) {
      chunks.push(chunk);
    }

    expect(chunks[0].delta.content).toBe("好");
    expect(chunks[1].toolCalls?.[0]).toEqual({ id: "call_1", toolName: "read_file", argumentsDelta: "{\"path\"" });
    expect(chunks[2].toolCalls?.[0]).toEqual({ id: "call_1", toolName: "read_file", argumentsDelta: ":\"README.md\"}" });
    expect(chunks.at(-1)).toMatchObject({
      finishReason: "tool_calls",
      usage: { inputTokens: 2, outputTokens: 4, totalTokens: 6 },
    });
  });

  it("does not require API key for local Ollama by default", async () => {
    const provider = new OllamaCompatibleProvider({
      fetch: async () => jsonResponse({
        choices: [{ message: { content: "local ok" }, finish_reason: "stop" }],
      }),
    });

    await expect(provider.chat(baseRequest({ modelId: "llama3.1" }))).resolves.toBe("local ok");
  });
});

function baseRequest(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    sessionId: "session-1",
    modelId: "deepseek-chat",
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
