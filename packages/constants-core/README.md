# @ema-agent/constants-core

## 一句话职责

全系统共享的纯常量、错误码与基础工具函数。无业务逻辑，无外部依赖。

## 上游依赖（我可以 import 谁）

- 无（本包是最底层，禁止 import 任何其他包）

## 下游消费者（谁可以 import 我）

- 所有包都可以 import `constants-core`

## 对外接口

- `export const ErrorCode` —— 错误码枚举
- `export class EmaError` —— 统一错误类型
- `export function isEmaError()` —— 错误类型守卫
- `export const AGENT_MODE`、`MAX_MESSAGE_LENGTH` 等常量

## 禁止事项

- ❌ 禁止 import 任何 `@ema-agent/*` 包（包括 core-types）
- ❌ 禁止包含业务逻辑
- ❌ 禁止包含异步操作（fetch、fs 等）
- ❌ 禁止包含副作用（全局状态修改、事件监听等）
