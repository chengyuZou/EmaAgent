import { describe, expect, it } from "vitest"

import { asId } from "../src/ids.js"
import type {
  ArtifactId,
  MessageId,
  RequestId,
  SessionId,
  StepId,
  ToolCallId,
  UnixMs,
} from "../src/ids.js"
import type { EmaMode } from "../src/mode.js"
import type {
  SseEvent,
  TurnCompletedEvent,
  TurnFailedEvent,
  TurnCancelledEvent,
  TextDeltaEvent,
  TextDoneEvent,
  PermissionRequestEvent,
  StepStartEvent,
  StepProgressEvent,
  StepEndEvent,
  RetrievalStartEvent,
  RetrievalEndEvent,
  CompressionNotifyEvent,
  ArtifactCreateEvent,
  ArtifactFinalizeEvent,
  ErrorEvent,
  StageCueEvent,
} from "../src/event.js"

// 所有事件测试共享的工厂值
const requestId = asId<RequestId>("req_evt")
const sessionId = asId<SessionId>("ses_evt")
const now: UnixMs = 1700000000000
const messageId = asId<MessageId>("msg_evt")
const toolCallId = asId<ToolCallId>("tc_evt")
const stepId = asId<StepId>("step_evt")

describe("SseEvent — 事件联合类型", () => {
  it("TurnStartedEvent 满足 SseEvent 约束", () => {
    const event: SseEvent = {
      type: "turn_started",
      requestId,
      sessionId,
      at: now,
      mode: "chat" as EmaMode,
      userMessageId: messageId,
      assistantMessageId: messageId,
    }
    expect(event.type).toBe("turn_started")
  })

  it("TurnCompletedEvent 携带 usage 信息", () => {
    const event: TurnCompletedEvent = {
      type: "turn_completed",
      requestId,
      sessionId,
      at: now,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    }
    expect(event.usage?.totalTokens).toBe(150)
  })

  it("TurnCompletedEvent 的 usage 可选——部分 provider 不返回 cost", () => {
    const event: TurnCompletedEvent = {
      type: "turn_completed",
      requestId,
      sessionId,
      at: now,
    }
    expect(event.usage).toBeUndefined()
  })

  it("TurnFailedEvent 携带错误码和重试标志", () => {
    const event: TurnFailedEvent = {
      type: "turn_failed",
      requestId,
      sessionId,
      at: now,
      code: "tool_failed",
      message: "工具 run_command 执行超时",
      retryable: true,
      artifactIds: [],
    }
    expect(event.retryable).toBe(true)
  })

  it("TurnCancelledEvent 记录取消前的最后步骤", () => {
    const event: TurnCancelledEvent = {
      type: "turn_cancelled",
      requestId,
      sessionId,
      at: now,
      lastStepId: stepId,
    }
    expect(event.lastStepId).toBe(stepId)
  })
})

describe("文本流事件", () => {
  it("TextDeltaEvent 是增量片段", () => {
    const event: TextDeltaEvent = {
      type: "text_delta",
      requestId,
      sessionId,
      at: now,
      messageId,
      delta: "你好",
      blockId: "block_1",
    }
    expect(event.delta).toBe("你好")
  })

  it("TextDoneEvent 携带完整文本用于校验", () => {
    const event: TextDoneEvent = {
      type: "text_done",
      requestId,
      sessionId,
      at: now,
      messageId,
      fullText: "你好，世界",
      blockId: "block_1",
    }
    expect(event.fullText).toBe("你好，世界")
  })
})

describe("工具调用事件", () => {
  it("ToolCallStartEvent → ToolCallArgsEvent → ToolCallEndEvent → ToolResultEvent 完整链路", () => {
    const start: SseEvent = {
      type: "tool_call_start",
      requestId,
      sessionId,
      at: now,
      messageId,
      toolCallId,
      toolName: "read_file",
      source: "local",
    }
    const args: SseEvent = {
      type: "tool_call_args",
      requestId,
      sessionId,
      at: now,
      messageId,
      toolCallId,
      argsDelta: '{"path":',
    }
    const end: SseEvent = {
      type: "tool_call_end",
      requestId,
      sessionId,
      at: now,
      messageId,
      toolCallId,
      args: { path: "/tmp/test.txt" },
    }
    const result: SseEvent = {
      type: "tool_result",
      requestId,
      sessionId,
      at: now,
      messageId,
      toolCallId,
      toolName: "read_file",
      success: true,
      resultStr: "文件内容...",
      durationMs: 15,
    }

    expect(start.type).toBe("tool_call_start")
    expect(args.type).toBe("tool_call_args")
    expect(end.type).toBe("tool_call_end")
    expect(result.type).toBe("tool_result")
  })
})

describe("权限请求事件", () => {
  it("支持 4 级风险：low, medium, high, critical", () => {
    const risks = ["low", "medium", "high", "critical"] as const
    for (const risk of risks) {
      const event: PermissionRequestEvent = {
        type: "permission_request",
        requestId,
        sessionId,
        at: now,
        messageId,
        toolCallId,
        toolName: "run_command",
        summary: "执行 rm -rf /tmp/test",
        risk,
      }
      expect(event.risk).toBe(risk)
    }
  })
})

describe("ReAct 步骤事件", () => {
  it("StepStartEvent 的 stepType 包含所有 ReAct 阶段", () => {
    const validTypes = ["context", "thinking", "tool", "diff", "artifact", "response", "narrative_recall"] as const

    for (const stepType of validTypes) {
      const event: StepStartEvent = {
        type: "step_start",
        requestId,
        sessionId,
        at: now,
        stepId,
        stepType,
        title: `${stepType} 阶段`,
      }
      expect(event.stepType).toBe(stepType)
    }
  })

  it("StepEndEvent 有三种结束状态", () => {
    const statuses = ["completed", "failed", "skipped"] as const
    for (const status of statuses) {
      const event: StepEndEvent = {
        type: "step_end",
        requestId,
        sessionId,
        at: now,
        stepId,
        status,
      }
      expect(event.status).toBe(status)
    }
  })

  it("StepProgressEvent 携带进度描述", () => {
    const event: StepProgressEvent = {
      type: "step_progress",
      requestId,
      sessionId,
      at: now,
      stepId,
      detail: "已读取 3/5 个文件",
    }
    expect(event.detail).toBe("已读取 3/5 个文件")
  })
})

describe("检索事件", () => {
  it("RetrievalStartEvent 标记检索来源", () => {
    const event: RetrievalStartEvent = {
      type: "retrieval_start",
      requestId,
      sessionId,
      at: now,
      messageId,
      source: "narrative",
    }
    expect(event.source).toBe("narrative")
  })

  it("RetrievalEndEvent 携带完整检索结果", () => {
    const event: RetrievalEndEvent = {
      type: "retrieval_end",
      requestId,
      sessionId,
      at: now,
      messageId,
      content: "检索到 3 条相关剧情...",
      source: "narrative",
    }
    expect(event.content).toBeTruthy()
  })
})

describe("辅助事件", () => {
  it("CompressionNotifyEvent 记录压缩前后 token 数", () => {
    const event: CompressionNotifyEvent = {
      type: "compression_notify",
      requestId,
      sessionId,
      at: now,
      messageId,
      originalTokens: 5000,
      compressedTokens: 2000,
      content: "压缩后摘要...",
    }
    expect(event.originalTokens).toBeGreaterThan(event.compressedTokens)
  })

  it("ArtifactCreateEvent 与 ArtifactFinalizeEvent 共享 ArtifactSummary", () => {
    const artifactId = asId<ArtifactId>("art_001")
    const summary = { id: artifactId, sessionId, requestId, kind: "code" as const, title: "main.ts", mime: "text/x-typescript", status: "draft" as const, createdAt: now, updatedAt: now }
    const create: ArtifactCreateEvent = {
      type: "artifact_create",
      requestId,
      sessionId,
      at: now,
      artifactId,
      summary,
    }
    const finalize: ArtifactFinalizeEvent = {
      type: "artifact_finalize",
      requestId,
      sessionId,
      at: now,
      artifactId,
      summary,
    }
    expect(create.summary.id).toBe(finalize.summary.id)
  })

  it("ErrorEvent 在流内传递可重试标记", () => {
    const event: ErrorEvent = {
      type: "error",
      requestId,
      sessionId,
      at: now,
      code: "rate_limited",
      message: "请求过频，请稍后重试",
      retryable: true,
    }
    expect(event.retryable).toBe(true)
  })

  it("StageCueEvent 控制 Live2D 表情和动作", () => {
    const event: StageCueEvent = {
      type: "stage_cue",
      requestId,
      sessionId,
      at: now,
      cue: {
        source: "act",
        expression: "happy",
        motion: "nod",
        mouth: "speaking",
        priority: 5,
        durationMs: 2000,
      },
    }
    expect(event.cue.expression).toBe("happy")
  })
})
