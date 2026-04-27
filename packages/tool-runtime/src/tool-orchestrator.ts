/**
 * 工具编排器：并发安全判断、批次分区与执行。
 */

import type { ToolCall, ToolResult } from "@ema-agent/core-types";
import { MAX_PARALLEL_READONLY_TOOLS } from "@ema-agent/constants-core";
import { getTool } from "./tool-registry.js";

/** 工具调用批次 */
export interface ToolCallBatch {
  calls: ToolCall[];
  concurrent: boolean;
}

/** 单工具执行请求 */
export interface ExecuteSingleRequest {
  sessionId: string;
  requestId: string;
  traceId: string;
  call: ToolCall;
}

/** 批次执行请求 */
export interface ExecuteBatchRequest {
  sessionId: string;
  requestId: string;
  traceId: string;
  batches: ToolCallBatch[];
}

/** 批次执行结果 */
export interface ToolBatchResult {
  callId: string;
  result: ToolResult;
}

/**
 * 按并发安全性将工具调用分组成批次。
 *
 * @remarks
 * 只读工具可并发（上限 {@link MAX_PARALLEL_READONLY_TOOLS}），
 * 写工具强制串行，以保证副作用顺序。
 */
export function partitionToolCalls(calls: ToolCall[]): ToolCallBatch[] {
  const batches: ToolCallBatch[] = [];
  let currentConcurrent: ToolCall[] = [];

  for (const call of calls) {
    const tool = getTool(call.toolName);
    if (!tool) continue;

    const safe = tool.isConcurrencySafe();
    if (!safe) {
      if (currentConcurrent.length > 0) {
        batches.push({ calls: currentConcurrent, concurrent: true });
        currentConcurrent = [];
      }
      batches.push({ calls: [call], concurrent: false });
    } else {
      if (currentConcurrent.length >= MAX_PARALLEL_READONLY_TOOLS) {
        batches.push({ calls: currentConcurrent, concurrent: true });
        currentConcurrent = [];
      }
      currentConcurrent.push(call);
    }
  }

  if (currentConcurrent.length > 0) {
    batches.push({ calls: currentConcurrent, concurrent: true });
  }

  return batches;
}

/**
 * 执行单工具调用。
 */
export async function executeSingleTool(req: ExecuteSingleRequest): Promise<ToolResult> {
  const tool = getTool(req.call.toolName);
  if (!tool) {
    return {
      toolCallId: req.call.id,
      toolName: req.call.toolName,
      success: false,
      content: "",
      error: `Tool not found: ${req.call.toolName}`,
      durationMs: 0,
    };
  }

  const start = Date.now();
  try {
    const result = await tool.execute({
      sessionId: req.sessionId,
      requestId: req.requestId,
      traceId: req.traceId,
      args: req.call.arguments,
    });
    return { ...result, durationMs: Date.now() - start };
  } catch (err) {
    return {
      toolCallId: req.call.id,
      toolName: req.call.toolName,
      success: false,
      content: "",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

/**
 * 按批次顺序执行工具调用。
 */
export async function executeToolBatches(req: ExecuteBatchRequest): Promise<ToolBatchResult[]> {
  const results: ToolBatchResult[] = [];

  for (const batch of req.batches) {
    if (batch.concurrent) {
      const batchResults = await Promise.all(
        batch.calls.map((call) =>
          executeSingleTool({
            sessionId: req.sessionId,
            requestId: req.requestId,
            traceId: req.traceId,
            call,
          }),
        ),
      );
      for (const r of batchResults) {
        results.push({ callId: r.toolCallId, result: r });
      }
    } else {
      const call = batch.calls[0];
      if (!call) continue;
      const r = await executeSingleTool({
        sessionId: req.sessionId,
        requestId: req.requestId,
        traceId: req.traceId,
        call,
      });
      results.push({ callId: r.toolCallId, result: r });
    }
  }

  return results;
}
