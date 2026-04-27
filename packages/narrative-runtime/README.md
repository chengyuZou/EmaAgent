# @ema-agent/narrative-runtime

## 一句话职责

剧情模式上下文构建：Python Bridge 调用、世界观状态缓存、周目路由、结果去重。

## 上游依赖（我可以 import 谁）

- `@ema-agent/core-types` —— WorldState、NarrativeBridgeQuery、NarrativeBridgeResult
- `@ema-agent/constants-core` —— 剧情相关常量

## 下游消费者（谁可以 import 我）

- `@ema-agent/orchestrator-runtime` —— narrative 模式调用
- `@ema-agent/memory-runtime` —— 将 narrative 结果转为 ContextBlock

## 对外接口

- `export interface NarrativeRuntime` —— 剧情运行时接口
- `export function buildNarrativeContext()` —— 构建剧情上下文
- `export function queryPythonBridge()` —— Python Bridge 查询

## 禁止事项

- ❌ 禁止 import `memory-runtime`（memory 可以消费 narrative 结果，但 narrative 不应依赖 memory）
- ❌ 禁止 import `orchestrator-runtime`（防止循环）
- ❌ 禁止在 TS 侧做剧情逻辑判断（重计算在 Python Bridge）
- ❌ 禁止直接读写 lightrag 存储目录（通过 Python API）
