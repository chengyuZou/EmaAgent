import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@ema-agent/core-types";
import { buildContextWindow, defaultEstimateTokens } from "./context-window.js";

describe("defaultEstimateTokens", () => {
  it("estimates 100 Chinese chars as ~40 tokens", () => {
    const text = "这是一段测试的文本".repeat(10); // 90 字符
    expect(defaultEstimateTokens(text)).toBe(36); // ceil(90 / 2.5)
  });
});

describe("buildContextWindow", () => {
  it("returns all messages when under budget", () => {
    const msgs: ChatMessage[] = [
      { id: "1", role: "user", content: "短", createdAt: 1 },
      { id: "2", role: "assistant", content: "回", createdAt: 2 },
    ];
    expect(buildContextWindow(msgs, 100)).toHaveLength(2);
  });

  it("truncates old messages when over budget", () => {
    // 每条约 50 字符 ≈ 20 token，预算 50 token → 应保留最近 2-3 条
    const msgs: ChatMessage[] = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      role: "user",
      content: `这是一条用于测试上下文窗口截断功能的比较长消息内容 ${i}`,
      createdAt: i,
    })) as ChatMessage[];

    const result = buildContextWindow(msgs, 50);
    expect(result.length).toBeLessThan(10);
    expect(result[result.length - 1].id).toBe("9"); // 最新消息一定保留
  });

  it("allows custom estimateTokens function", () => {
    const msgs: ChatMessage[] = [
      { id: "1", role: "user", content: "a", createdAt: 1 },
      { id: "2", role: "user", content: "b", createdAt: 2 },
      { id: "3", role: "user", content: "c", createdAt: 3 },
    ];

    // 注入精确 tokenizer：每条固定 10 token
    const result = buildContextWindow(msgs, 25, () => 10);
    expect(result.length).toBe(2); // 2*10=20 ≤ 25，保留 id="2" 和 "3"
    expect(result[result.length - 1].id).toBe("3");
  });

  it("returns empty array for empty input", () => {
    expect(buildContextWindow([], 100)).toEqual([]);
  });
});
