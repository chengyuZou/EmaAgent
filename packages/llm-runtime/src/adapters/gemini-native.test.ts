import type { ChatCompletionRequest } from "@ema-agent/core-types";
import { describe, expect, it } from "vitest";
import type { RuntimeFetch } from "../types.js";
import { GeminiNativeProvider } from "./gemini-native.js";

describe("GeminiNativeProvider", () => {
  it("maps unified requests to Gemini generateContent payload", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | undefined;
    const provider = new GeminiNativeProvider({
      apiKey: "test-key",
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          candidates: [{ content: { parts: [{ text: "收到。" }] } }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
        });
      },
    });

    const text = await provider.chat(baseRequest({
      tools: [
        {
          name: "read_file",
          description: "读取文件",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      ],
    }));

    const systemInstruction = capturedBody?.systemInstruction as { parts: Array<{ text: string }> };
    const contents = capturedBody?.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    const tools = capturedBody?.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>;

    expect(text).toBe("收到。");
    expect(capturedUrl).toContain("/models/gemini-2.5-flash:generateContent");
    expect(systemInstruction.parts[0].text).toBe("你是 Ema。");
    expect(contents[0]).toEqual({ role: "user", parts: [{ text: "帮我整理任务。" }] });
    expect(tools[0].functionDeclarations[0].name).toBe("read_file");
  });

  it("normalizes Gemini streaming text, function call, and usage", async () => {
    const provider = new GeminiNativeProvider({
      apiKey: "test-key",
      fetch: sseFetch([
        sseData({
          candidates: [{ content: { parts: [{ text: "好" }] } }],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
        }),
        sseData({
          candidates: [
            {
              content: { parts: [{ functionCall: { name: "read_file", args: { path: "README.md" } } }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 4, totalTokenCount: 6 },
        }),
      ].join("")),
    });

    const chunks = [];
    for await (const chunk of provider.chatStream(baseRequest())) {
      chunks.push(chunk);
    }

    expect(chunks[0].delta.content).toBe("好");
    expect(chunks[1].toolCalls?.[0]).toMatchObject({
      toolName: "read_file",
      argumentsDelta: "{\"path\":\"README.md\"}",
    });
    expect(chunks.at(-1)).toMatchObject({
      finishReason: "tool_calls",
      usage: { inputTokens: 2, outputTokens: 4, totalTokens: 6 },
    });
  });
});

function baseRequest(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    sessionId: "session-1",
    modelId: "gemini-2.5-flash",
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
