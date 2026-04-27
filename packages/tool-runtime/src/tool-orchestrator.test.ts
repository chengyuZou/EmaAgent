/**
 * Tool Runtime - orchestrator 单元测试。
 *
 * @remarks
 * 覆盖 partitionToolCalls 的并发分区逻辑与 executeToolBatches 的执行流程。
 */

import { describe, expect, it } from "vitest";
import { partitionToolCalls, executeSingleTool } from "./tool-orchestrator.js";
import type { ToolCall, ToolResult } from "@ema-agent/core-types";

// 注册一些 mock 工具供测试使用
import { registerTool } from "./tool-registry.js";
import type { RuntimeTool, ToolExecutionContext } from "./tool-spec.js";

function createMockTool(
  name: string,
  opts: { concurrent?: boolean; risk?: "low" | "medium" | "high" } = {},
): RuntimeTool {
  return {
    name,
    description: `Mock tool: ${name}`,
    parameters: {},
    isConcurrencySafe: () => opts.concurrent ?? false,
    riskLevel: () => opts.risk ?? "low",
    execute: async (ctx: ToolExecutionContext): Promise<ToolResult> => ({
      toolCallId: ctx.args.callId as string,
      toolName: name,
      success: true,
      content: `result-${name}`,
      durationMs: 0,
    }),
  };
}

function makeCall(id: string, toolName: string): ToolCall {
  return { id, toolName, arguments: { callId: id } };
}

describe("partitionToolCalls", () => {
  it("全为只读工具时应分成并发批次（每批最多4个）", () => {
    registerTool(createMockTool("read1", { concurrent: true }));
    registerTool(createMockTool("read2", { concurrent: true }));
    registerTool(createMockTool("read3", { concurrent: true }));
    registerTool(createMockTool("read4", { concurrent: true }));
    registerTool(createMockTool("read5", { concurrent: true }));

    const calls: ToolCall[] = [
      makeCall("c1", "read1"),
      makeCall("c2", "read2"),
      makeCall("c3", "read3"),
      makeCall("c4", "read4"),
      makeCall("c5", "read5"),
    ];

    const batches = partitionToolCalls(calls);
    expect(batches).toHaveLength(2);
    expect(batches[0]?.concurrent).toBe(true);
    expect(batches[0]?.calls).toHaveLength(4);
    expect(batches[1]?.concurrent).toBe(true);
    expect(batches[1]?.calls).toHaveLength(1);
  });

  it("全为写工具时应每个单独串行批次", () => {
    registerTool(createMockTool("write1", { concurrent: false }));
    registerTool(createMockTool("write2", { concurrent: false }));

    const calls: ToolCall[] = [makeCall("c1", "write1"), makeCall("c2", "write2")];

    const batches = partitionToolCalls(calls);
    expect(batches).toHaveLength(2);
    expect(batches[0]?.concurrent).toBe(false);
    expect(batches[0]?.calls).toHaveLength(1);
    expect(batches[1]?.concurrent).toBe(false);
    expect(batches[1]?.calls).toHaveLength(1);
  });

  it("交替排列时应拆分为并发块+串行块+并发块", () => {
    registerTool(createMockTool("readA", { concurrent: true }));
    registerTool(createMockTool("writeB", { concurrent: false }));
    registerTool(createMockTool("readC", { concurrent: true }));

    const calls: ToolCall[] = [
      makeCall("c1", "readA"),
      makeCall("c2", "writeB"),
      makeCall("c3", "readC"),
    ];

    const batches = partitionToolCalls(calls);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toEqual({ calls: [calls[0]], concurrent: true });
    expect(batches[1]).toEqual({ calls: [calls[1]], concurrent: false });
    expect(batches[2]).toEqual({ calls: [calls[2]], concurrent: true });
  });

  it("不存在的工具应被跳过", () => {
    const calls: ToolCall[] = [makeCall("c1", "nonexistent-tool")];
    const batches = partitionToolCalls(calls);
    expect(batches).toHaveLength(0);
  });
});

describe("executeSingleTool", () => {
  it("存在的工具应返回成功结果", async () => {
    registerTool(createMockTool("echo", { concurrent: true }));

    const result = await executeSingleTool({
      sessionId: "s1",
      requestId: "r1",
      traceId: "t1",
      call: makeCall("c1", "echo"),
    });

    expect(result.success).toBe(true);
    expect(result.toolName).toBe("echo");
    expect(result.toolCallId).toBe("c1");
  });

  it("不存在的工具应返回失败兜底", async () => {
    const result = await executeSingleTool({
      sessionId: "s1",
      requestId: "r1",
      traceId: "t1",
      call: makeCall("c1", "missing-tool"),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Tool not found");
    expect(result.durationMs).toBe(0);
  });
});
