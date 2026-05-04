import { describe, expect, it } from "vitest"

import {
  REPEATED_ERROR_LIMIT,
  DEFAULT_REACT_MAX_STEPS,
  READ_ONLY_TOOL_PATTERNS,
  DANGEROUS_TOOL_NAMES,
  DANGEROUS_FILE_OPERATIONS,
  MAX_PARALLEL_READONLY_TOOLS,
  AGENT_RISK_LEVELS,
  REACT_STATUSES,
  REACT_STEP_TYPES,
  BUILTIN_TOOL_NAMES,
} from "../src/agent.js"

describe("Agent 熔断常量", () => {
  it("REPEATED_ERROR_LIMIT 为 3（v0.4 默认值）", () => {
    expect(REPEATED_ERROR_LIMIT).toBe(3)
  })

  it("DEFAULT_REACT_MAX_STEPS 为 20", () => {
    expect(DEFAULT_REACT_MAX_STEPS).toBe(20)
  })

  it("MAX_PARALLEL_READONLY_TOOLS 为 3（v0.4 Semaphore 值）", () => {
    expect(MAX_PARALLEL_READONLY_TOOLS).toBe(3)
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
    expect(DANGEROUS_FILE_OPERATIONS).not.toContain("read")
  })
})

describe("枚举值域全集", () => {
  it("AGENT_RISK_LEVELS 为四档升序", () => {
    expect(AGENT_RISK_LEVELS).toEqual(["low", "medium", "high", "critical"])
  })

  it("REACT_STATUSES 覆盖完整 think→act 循环", () => {
    expect(REACT_STATUSES).toEqual(["idle", "thinking", "acting", "finished", "error"])
  })

  it("REACT_STEP_TYPES 包含 7 种步骤类型", () => {
    expect(REACT_STEP_TYPES).toHaveLength(7)
    expect(REACT_STEP_TYPES).toContain("context")
    expect(REACT_STEP_TYPES).toContain("thinking")
    expect(REACT_STEP_TYPES).toContain("tool")
  })

  it("BUILTIN_TOOL_NAMES 包含 12 个内置工具", () => {
    expect(BUILTIN_TOOL_NAMES).toHaveLength(12)
    expect(BUILTIN_TOOL_NAMES).toContain("read_file")
    expect(BUILTIN_TOOL_NAMES).toContain("run_command")
    expect(BUILTIN_TOOL_NAMES).toContain("web_fetch")
  })
})
