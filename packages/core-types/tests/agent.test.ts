import { describe, expect, it } from "vitest"

import type { AgentRiskLevel, AgentLoopStatus, AgentPhase, AgentStrategy, ToolIntent, RiskClassification, AgentLoopState, ErrorGuardState } from "../src/agent.js"

import { asId } from "../src/ids.js"
import type { RequestId, SessionId, ToolCallId, UnixMs } from "../src/ids.js"

describe("AgentStrategy", () => {
  it("三种策略：plan、debug、full", () => {
    const strategies: AgentStrategy[] = ["plan", "debug", "full"]
    expect(strategies).toHaveLength(3)
  })
})

describe("AgentPhase", () => {
  it("五阶段认知循环：plan → think → act → debug → reflect", () => {
    const phases: AgentPhase[] = ["plan", "think", "act", "debug", "reflect"]
    expect(phases).toHaveLength(5)
  })
})

describe("AgentRiskLevel", () => {
  it("四档风险值域正确", () => {
    const levels: AgentRiskLevel[] = ["low", "medium", "high", "critical"]
    expect(levels).toHaveLength(4)
    for (const level of levels) {
      expect(["low", "medium", "high", "critical"]).toContain(level)
    }
  })
})

describe("AgentLoopStatus", () => {
  it("五种状态覆盖完整认知循环", () => {
    const statuses: AgentLoopStatus[] = ["idle", "thinking", "acting", "finished", "error"]
    expect(statuses).toHaveLength(5)
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

describe("AgentLoopState", () => {
  const now: UnixMs = 1700000000000
  const requestId = asId<RequestId>("req_state")
  const sessionId = asId<SessionId>("ses_state")

  it("idle 状态的默认值正确", () => {
    const state: AgentLoopState = {
      sessionId,
      requestId,
      mode: "agent",
      strategy: "full",
      userInput: "帮我找文件",
      iteration: 0,
      maxIterations: 15,
      currentThought: "",
      currentToolCalls: [],
      toolResults: [],
      planTasks: [],
      finalAnswer: "",
      status: "idle",
      startedAt: now,
    }
    expect(state.status).toBe("idle")
    expect(state.iteration).toBe(0)
    expect(state.strategy).toBe("full")
    expect(state.currentToolCalls).toHaveLength(0)
  })

  it("plan 策略不产生 tool_calls", () => {
    const state: AgentLoopState = {
      sessionId,
      requestId,
      mode: "agent",
      strategy: "plan",
      userInput: "帮我规划一下怎么学 Rust",
      iteration: 1,
      maxIterations: 15,
      currentThought: "用户想系统学习 Rust...",
      currentToolCalls: [],
      toolResults: [],
      planTasks: ["选教材", "搭建环境", "从所有权开始"],
      finalAnswer: "",
      status: "finished",
      startedAt: now,
      endedAt: now + 5000,
    }
    expect(state.strategy).toBe("plan")
    expect(state.planTasks).toHaveLength(3)
  })

  it("error 状态携带错误描述", () => {
    const state: AgentLoopState = {
      sessionId,
      requestId,
      mode: "agent",
      strategy: "full",
      userInput: "test",
      iteration: 3,
      maxIterations: 15,
      currentThought: "",
      currentToolCalls: [],
      toolResults: [],
      planTasks: [],
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
