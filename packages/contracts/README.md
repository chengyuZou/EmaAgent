# @ema-agent/contracts

EmaAgent 的公共类型契约包。**纯类型导出,禁止引入任何运行时依赖**——所有跨包共享的 DTO、事件、ID、Provider 定义集中在此,业务包只 `import type` 不重复定义。

## 定位

三层进程隔离架构(Tauri ⇄ ema-core ⇄ ema-bridge)中,contracts 是**唯一**的类型契约层。任何被 ≥2 个包使用的类型必须在此定义;业务包禁止跨包 import 内部类型,只能 import contracts。

## 导出

| 模块 | 内容 |
|---|---|
| `ids` | 品牌标量 ID(SessionId / TurnId / ArtifactId / EmbeddingSpaceId / HookInvocationId 等),nominal typing 防混用 |
| `turns` | Turn/Run 状态机 + `contentParts`(text / image_url / image_data / audio_data / file_data / file_url) |
| `events` | `EmaStreamEvent`(53 种 SSE 事件)+ `SubagentInnerEvent` |
| `messages` | `LlmMessage` / `MessageBlocks` / `TurnAttachment`(UI 元数据,存 `turn_attachments` 表)/ `MessageContentPart` |
| `artifact` | Artifact 区分联合(inline/file 内容 + applied/rejected 状态) |
| `wire` | REST wire 类型(`MessageWire` 等,统一放 wire.ts) |
| `kb` | KB 相关 DTO |
| `agents` | Agent / Subagent 契约 |
| `session-ownership` | `SessionOwnershipFacade` 接口 |
| `errors` | 跨包错误码 |

## 红线

- **禁引运行时依赖**——只导出 `type` / `interface` / `const`,不导出可执行逻辑
- 前端只消费结构化 `EmaStreamEvent`,禁止解析日志字符串
- 新增 interface / type 前先 grep 现有的,能 `extends` / `implements` 就别重写(见 Emabug B-066)
- 注释要与真实存储/字段对齐,不承诺不存在的字段(见 B-067:`TurnAttachment` 注释曾误标 `messages.attachments_json` 列,实为 `turn_attachments` 独立表)
