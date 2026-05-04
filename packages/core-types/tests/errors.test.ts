import { describe, expect, it } from "vitest"

import { EmaError, toUiErrorView } from "../src/errors.js"
import { asId } from "../src/ids.js"
import type { RequestId } from "../src/ids.js"

describe("EmaError", () => {
  it("是 Error 的子类", () => {
    const err = new EmaError("bad_request", "参数缺失")
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(EmaError)
  })

  it("name 属性固定为 'EmaError'", () => {
    const err = new EmaError("internal_error", "出错了")
    expect(err.name).toBe("EmaError")
  })

  it("所有构造参数正确保存", () => {
    const err = new EmaError(
      "tool_failed",
      "文件不存在",
      true, // retryable
      { toolName: "read_file", path: "/tmp/missing.txt" },
    )

    expect(err.code).toBe("tool_failed")
    expect(err.message).toBe("文件不存在")
    expect(err.retryable).toBe(true)
    expect(err.details).toEqual({ toolName: "read_file", path: "/tmp/missing.txt" })
  })

  it("retryable 和 severity 默认值正确", () => {
    const err = new EmaError("rate_limited", "请求过频")

    expect(err.retryable).toBe(false)
    expect(err.severity).toBe("error")
  })

  it("可携带 severity 覆盖默认值", () => {
    const err = new EmaError("bad_request", "mode 参数为空", false, undefined, "warning")

    expect(err.severity).toBe("warning")
  })
})

describe("toUiErrorView", () => {
  const requestId = asId<RequestId>("req_test")

  it("EmaError 实例——完整映射所有字段", () => {
    const emaErr = new EmaError("tool_denied", "用户拒绝了工具调用", false, { toolName: "run_command" }, "warning")

    const view = toUiErrorView(emaErr, "trace_001", requestId)

    expect(view).toEqual({
      requestId,
      traceId: "trace_001",
      code: "tool_denied",
      message: "用户拒绝了工具调用",
      severity: "warning",
      details: { toolName: "run_command" },
    })
  })

  it("标准 Error 实例——归为 internal_error", () => {
    const stdErr = new Error("意外崩溃")

    const view = toUiErrorView(stdErr, undefined, requestId)

    expect(view.code).toBe("internal_error")
    expect(view.message).toBe("意外崩溃")
    expect(view.severity).toBe("error")
    expect(view.requestId).toBe(requestId)
    expect(view.details?.stack).toBeDefined()
  })

  it("非 Error 的任意值——归为 internal_error 并保留原始值", () => {
    const view = toUiErrorView("一段字符串错误", undefined, undefined)

    expect(view.code).toBe("internal_error")
    expect(view.message).toBe("Unknown internal error")
    expect(view.details?.raw).toBe("一段字符串错误")
  })

  it("null / undefined 的兜底行为", () => {
    const view = toUiErrorView(null)

    expect(view.code).toBe("internal_error")
    expect(view.message).toBe("Unknown internal error")
  })

  it("traceId 为可选参数", () => {
    const emaErr = new EmaError("bad_request", "缺少 field")
    const withTrace = toUiErrorView(emaErr, "trace_abc")
    const withoutTrace = toUiErrorView(emaErr)

    expect(withTrace.traceId).toBe("trace_abc")
    expect(withoutTrace.traceId).toBeUndefined()
  })
})
