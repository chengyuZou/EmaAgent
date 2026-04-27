import { describe, expect, it } from "vitest";
import { buildRuntimeInputEnvelope } from "./src/input-pipeline.js";

describe("buildRuntimeInputEnvelope", () => {
  it("keeps rawUserQuery isolated from runtime prompt assembly", () => {
    const envelope = buildRuntimeInputEnvelope({
      rawUserQuery: "help me build the minimal loop",
      recentMessages: [],
      mode: "chat",
    });

    expect(envelope.rawUserQuery).toBe("help me build the minimal loop");
    expect(envelope.assembledUserPrompt).toBe("help me build the minimal loop");
    expect(envelope.contextBlocks).toEqual([]);
  });
});
