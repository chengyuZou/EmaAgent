import { describe, expect, it } from "vitest";
import { readSseMessages } from "./sse.js";

describe("readSseMessages", () => {
  it("parses SSE event/data blocks and joins multi-line data", async () => {
    const stream = streamFromText([
      "event: response.output_text.delta\n",
      "data: {\"delta\":\"你\"}\n",
      "data: {\"extra\":true}\n",
      "\n",
      ": keep-alive\n",
      "data: [DONE]\n\n",
    ].join(""));

    const messages = [];
    for await (const message of readSseMessages(stream)) {
      messages.push(message);
    }

    expect(messages).toEqual([
      {
        event: "response.output_text.delta",
        data: "{\"delta\":\"你\"}\n{\"extra\":true}",
        id: undefined,
        retry: undefined,
      },
      {
        event: undefined,
        data: "[DONE]",
        id: undefined,
        retry: undefined,
      },
    ]);
  });
});

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}
