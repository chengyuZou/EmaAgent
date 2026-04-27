# @ema-agent/tool-runtime

## 一句话职责

工具注册、编排与执行。统一 Tool Spec、支持 MCP/Skill 适配、并发安全。

## 上游依赖（我可以 import 谁）

- `@ema-agent/core-types` —— ToolSpec、ToolCall、ToolResult
- `@ema-agent/constants-core` —— 工具相关常量
- `@ema-agent/sandbox-runtime` —— 执行危险命令时调用沙箱（可选依赖）

## 下游消费者（谁可以 import 我）

- `@ema-agent/orchestrator-runtime` —— Agent 模式调用工具
- `@ema-agent/agent-harness` —— act 步骤执行工具

## 对外接口

- `export class ToolRegistry` —— 工具注册表
- `export class ToolOrchestrator` —— 工具编排与批量执行
- `export function partitionToolCalls()` —— 工具调用分组
- `export function executeToolBatches()` —— 并发执行

## 禁止事项

- ❌ 禁止 import `orchestrator-runtime`（防止循环）
- ❌ 禁止直接操作文件系统（危险操作走 sandbox-runtime）
- ❌ 禁止包含 Agent 决策逻辑（只负责执行，不负责决定执行哪个工具）
- ❌ 禁止在工具结果里混入 UI 渲染逻辑
