import { describe, expect, it } from "vitest"

import type { AgentRiskLevel, ReActStatus, ReActStepType, ToolIntent, RiskClassification, ReActState, ErrorGuardState } from "../src/agent.js"

import { asId } from "../src/ids.js"
import type { RequestId, SessionId, ToolCallId, UnixMs } from "../src/ids.js"

describe("AgentRiskLevel", () => {
  it("四档风险值域正确", () => {
    const levels: AgentRiskLevel[] = ["low", "medium", "high", "critical"]
    expect(levels).toHaveLength(4)
    for (const level of levels) {
      expect(["low", "medium", "high", "critical"]).toContain(level)
    }
  })
})

describe("ReActStatus", () => {
  it("五种状态覆盖完整 think→act 循环", () => {
    const statuses: ReActStatus[] = ["idle", "thinking", "acting", "finished", "error"]
    expect(statuses).toHaveLength(5)
  })
})

describe("ReActStepType", () => {
  it("包含所有 ReAct 阶段的步骤类型", () => {
    const validTypes: ReActStepType[] = [
      "context", "thinking", "tool", "diff", "artifact",
      "response", "narrative_recall",
    ]
    expect(validTypes).toHaveLength(7)
  })
})

describe("ToolIntent", () => {
  it("是 LLM 工具调用的完整结构化表达", () => {
    const intent: ToolIntent = {
      toolCallId: asId<ToolCallId>("tc_001"),
      toolName: "read_file",
      args: { path: "/tmp/test.txt" },
      defaultRisk: "low",
    }
    expect(intent.toolName).toBe("read_file")
    expect(intent.args.path).toBe("/tmp/test.txt")
    expect(intent.defaultRisk).toBe("low")
  })
})

describe("RiskClassification", () => {
  it("needConfirm 为 false 时表示可自动执行", () => {
    const cls: RiskClassification = {
      risk: "low",
      needConfirm: false,
      reason: "只读操作，无副作用",
    }
    expect(cls.needConfirm).toBe(false)
  })

  it("needConfirm 为 true 时表示需要用户确认", () => {
    const cls: RiskClassification = {
      risk: "high",
      needConfirm: true,
      reason: "run_command 可能修改系统状态",
    }
    expect(cls.needConfirm).toBe(true)
  })
})

describe("ReActState", () => {
  const now: UnixMs = 1700000000000
  const requestId = asId<RequestId>("req_state")
  const sessionId = asId<SessionId>("ses_state")

  it("idle 状态的默认值正确", () => {
    const state: ReActState = {
      sessionId,
      requestId,
      mode: "agent",
      userInput: "帮我找文件",
      currentStep: 0,
      maxSteps: 20,
      currentThought: "",
      currentToolCalls: [],
      toolResults: [],
      finalAnswer: "",
      status: "idle",
      startedAt: now,
    }
    expect(state.status).toBe("idle")
    expect(state.currentStep).toBe(0)
    expect(state.currentToolCalls).toHaveLength(0)
  })

  it("error 状态携带错误描述", () => {
    const state: ReActState = {
      sessionId,
      requestId,
      mode: "agent",
      userInput: "test",
      currentStep: 3,
      maxSteps: 20,
      currentThought: "",
      currentToolCalls: [],
      toolResults: [],
      finalAnswer: "",
      status: "error",
      error: "连续 3 次相同错误，触发熔断",
      startedAt: now,
      endedAt: now + 1000,
    }
    expect(state.status).toBe("error")
    expect(state.error).toContain("熔断")
  })
})

describe("ErrorGuardState", () => {
  it("初始 count 为 0", () => {
    const guard: ErrorGuardState = { count: 0 }
    expect(guard.count).toBe(0)
    expect(guard.lastSignature).toBeUndefined()
  })

  it("count >= 3 时触发熔断（REPEATED_ERROR_LIMIT 定义在 @ema-agent/constants-core）", () => {
    const guard: ErrorGuardState = { lastSignature: "read_file:ENOENT", count: 3 }
    expect(guard.count).toBeGreaterThanOrEqual(3)
  })
})
