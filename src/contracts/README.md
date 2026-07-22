# @ema-agent/contracts（迁移中，禁止新增）

中央 contracts 包正在按 [EmaRefactor.md](../../EmaRefactor.md) 的 C0～C5 路线拆除。它只承载尚未迁出的历史协议，不再是新类型、ID、错误或事件的默认落点。

## 已迁出

| 类型 | 当前所有者 |
|---|---|
| 模型 `Message`、模型可见 Block | `@ema-agent/llm` |
| `LlmCallId`、`LlmTokenUsage` | `@ema-agent/llm` |
| `UsageContext/UsageRecord/UsageRecorder` | `@ema-agent/usage` |
| Session Message → Model Message | `@ema-agent/context` 的 `messageBuilder` |
| Turn Request/Response/Stats、`EmaStreamEvent` 聚合协议 | `@ema-agent/turn` |
| Turn 客户端可见失败码 | `@ema-agent/turn` 的 `TurnFailureCode` |
| Artifact 类型与 ID | `@ema-agent/artifact` |
| 其他业务类型、事件和错误 | 各自业务模块 |

contracts 不得重新导出这些类型，也不得增加兼容别名。

## 尚待迁出

| 当前文件 | 目标所有者 |
|---|---|
| `ids.ts` 中剩余 ID | Session、Turn、Message、Character、Tool、Hook 等对应业务模块 |

## 迁移红线

- 只减不增；新业务类型直接归业务所有者。
- 不能为了消除 import 而复制同名大联合。
- 跨 HTTP/SSE 边界的稳定协议由业务模块 `protocol` 入口导出，并逐步补运行时 Schema。
- 删除一个旧导出前必须保证生产、测试和脚本引用归零，并通过全仓 typecheck/test。
