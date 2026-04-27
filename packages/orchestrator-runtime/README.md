# @ema-agent/orchestrator-runtime

## 一句话职责

三模式统一调度中心：chat / agent / narrative 的统一入口、输入治理、事件流组装。

## 上游依赖（我可以 import 谁）

- 所有下层包：
  - `@ema-agent/session-runtime`
  - `@ema-agent/llm-runtime`
  - `@ema-agent/tool-runtime`
  - `@ema-agent/memory-runtime`
  - `@ema-agent/narrative-runtime`
  - `@ema-agent/attachment-runtime`
  - `@ema-agent/multimodal-runtime`
  - `@ema-agent/sandbox-runtime`
- `@ema-agent/core-types` —— 事件协议、类型契约
- `@ema-agent/constants-core` —— 常量
- `@ema-agent/config-kernel` —— 配置读取

## 下游消费者（谁可以 import 我）

- `@ema-agent/api-gateway` —— HTTP/WebSocket 入口调用 runTurn()
- `@ema-agent/desktop-shell` —— 前端事件消费

**⚠️ 禁止被任何下层包 import（防止循环依赖）**

## 对外接口

- `export function runTurn()` —— 单轮统一入口
- `export function prepareRuntimeInput()` —— 输入组装与隔离
- `export class AgentHarness` —— Agent 模式 think/act/observe 循环
- `export function buildTurnMetadata()` —— 元数据构建

## 禁止事项

- ❌ **禁止被任何 runtime 包 import**（这是最重要的红线）
- ❌ 禁止直接操作 SQL 或文件系统（走 storage-sql / session-runtime）
- ❌ 禁止在 orchestrator 里写 Provider 具体实现（走 llm-runtime）
- ❌ 禁止绕过 memory-runtime 直接组装记忆上下文
- ❌ 禁止包含前端渲染逻辑
