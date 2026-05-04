import { describe, expect, it } from "vitest"

import type { AgentRiskLevel, ReActStatus, ReActStepType, ToolIntent, RiskClassification, ReActState, ErrorGuardState } from "../src/agent.js"
import {
  REPEATED_ERROR_LIMIT,
  DEFAULT_REACT_MAX_STEPS,
  READ_ONLY_TOOL_PATTERNS,
  DANGEROUS_TOOL_NAMES,
  DANGEROUS_FILE_OPERATIONS,
  MAX_PARALLEL_READONLY_TOOLS,
} from "../src/agent.js"

import { asId } from "../src/ids.js"
import type { RequestId, SessionId, ToolCallId, UnixMs } from "../src/ids.js"

describe("AgentRiskLevel", () => {
  it("四档风险值域正确", () => {
    const levels: AgentRiskLevel[] = ["low", "medium", "high", "critical"]
    expect(levels).toHaveLength(4)
    // 每个值都是合法的
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
      maxSteps: DEFAULT_REACT_MAX_STEPS,
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

  it("maxSteps 达到默认上限 20", () => {
    expect(DEFAULT_REACT_MAX_STEPS).toBe(20)
  })

  it("error 状态携带错误描述", () => {
    const state: ReActState = {
      sessionId,
      requestId,
      mode: "agent",
      userInput: "test",
      currentStep: 3,
      maxSteps: DEFAULT_REACT_MAX_STEPS,
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

  it("连续相同错误 3 次触发熔断", () => {
    const guard: ErrorGuardState = { lastSignature: "read_file:ENOENT", count: 3 }
    expect(guard.count).toBeGreaterThanOrEqual(REPEATED_ERROR_LIMIT)
  })
})

describe("工具分类常量（来自 v0.4）", () => {
  it("READ_ONLY_TOOL_PATTERNS 包含常见的只读工具", () => {
    expect(READ_ONLY_TOOL_PATTERNS).toContain("read_file")
    expect(READ_ONLY_TOOL_PATTERNS).toContain("search_text")
    expect(READ_ONLY_TOOL_PATTERNS).toContain("list_dir")
  })

  it("DANGEROUS_TOOL_NAMES 包含 shell 和代码执行", () => {
    expect(DANGEROUS_TOOL_NAMES).toContain("run_command")
    expect(DANGEROUS_TOOL_NAMES).toContain("run_python")
    expect(DANGEROUS_TOOL_NAMES).toContain("write_file")
  })

  it("DANGEROUS_FILE_OPERATIONS 包含写类文件操作", () => {
    expect(DANGEROUS_FILE_OPERATIONS).toContain("delete")
    expect(DANGEROUS_FILE_OPERATIONS).toContain("write")
    // read 不在危险列表中
    expect(DANGEROUS_FILE_OPERATIONS).not.toContain("read")
  })

  it("MAX_PARALLEL_READONLY_TOOLS 为 3（v0.4 Semaphore 值）", () => {
    expect(MAX_PARALLEL_READONLY_TOOLS).toBe(3)
  })
})
