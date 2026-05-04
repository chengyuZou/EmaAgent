import { describe, expect, it } from "vitest"

import { asId } from "../src/ids.js"
import type { ArtifactId, MessageId, RequestId, SessionId } from "../src/ids.js"

describe("asId — Brand 类型工厂", () => {
  it("将原始 string 包装为品牌类型，运行时身份保持不变", () => {
    const raw = "ses_abc_123"
    const sid = asId<SessionId>(raw)

    // 运行时：就是同一个字符串
    expect(sid).toBe(raw)
    expect(typeof sid).toBe("string")
  })

  it("相同值的两个 asId 在运行时相等", () => {
    const a = asId<RequestId>("req_001")
    const b = asId<RequestId>("req_001")

    expect(a).toBe(b)
  })

  it("不同值的两个 asId 在运行时不等", () => {
    const a = asId<SessionId>("ses_001")
    const b = asId<SessionId>("ses_002")

    expect(a).not.toBe(b)
  })

  it("不同品牌类型的相同值在运行时仍然相等（Brand 只是编译期概念）", () => {
    // Brand 是纯编译期概念——两个不同品牌的 string 在运行时完全一样。
    // 这里验证的是运行时行为，编译期的类型区分由 TypeScript 保证。
    const sid = asId<SessionId>("abc")
    const rid = asId<RequestId>("abc")

    // 运行时它们就是同一个字符串值
    expect((sid as string) === (rid as string)).toBe(true)
  })

  it("可以在 I/O 场景中正确往返", () => {
    // 模拟：JSON → 未知对象 → asId
    const raw = '{"id": "msg_001"}'
    const parsed: Record<string, string> = JSON.parse(raw)

    const messageId = asId<MessageId>(parsed.id)
    expect(messageId).toBe("msg_001")

    const artifactId = asId<ArtifactId>("art_001")
    expect(artifactId).toBe("art_001")
  })
})
