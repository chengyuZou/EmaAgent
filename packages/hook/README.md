# @ema-agent/hook

> EmaAgent 的 Hook 事件系统 —— 基于优先级的、可扩展的事件总线，支持串行/并行分批执行处理器。
> 更新时间 2026-5-30 10:00

---

## 整体架构

```
                    ┌─────────────────────────┐
                    │       HookBus           │
                    │                         │
  register() ──────►│  Map<HookEvent,         │
                    │    HandlerEntry[]>      │
  trigger() ───────►│                         │
                    │  ┌───────────────────┐  │
                    │  │ buildBatches()    │  │
                    │  │  → serial/parallel│  │
                    │  └───────┬───────────┘  │
                    │          │               │
                    │  ┌───────▼───────────┐  │
                    │  │ runOne()          │  │
                    │  │ runParallelBatch()│  │
                    │  └───────────────────┘  │
                    └─────────────────────────┘
```

模块提供：

- **11 个生命周期事件**，覆盖 LLM 调用、工具使用、回合。
- **优先级排序执行**（数字越小越先执行）。
- **串行与并行批次**：同一事件下的处理器可被分为串行块和并行块执行。
- **Payload 修改**：串行处理器可以替换 payload，下游处理器将收到修改后的值。
- **中止与警告语义**：处理器可中止整个链条；非关键处理器的失败只记录警告，不中断执行。
- **共享上下文 (`meta`)**：调用者拥有的暂存对象，在同一个 `trigger()` 调用中的所有处理器之间共享。

---

## 文件结构

```
src/
├── index.ts       # 入口，统一导出
├── bus.ts         # HookBus 核心实现
├── events.ts      # 事件定义与 payload 类型
├── priority.ts    # 优先级常量
└── bus.test.ts    # 测试文件
```

---

## 一、`priority.ts` —— 优先级常量

### 导出

| 导出名 | 类型 | 值 | 说明 |
|---|---|---|---|
| `PRIORITY_DEFAULT` | `number` | `100` | 默认优先级值 |
| `PRIORITY` | 对象常量 | 见下表 | 预定义的优先级槽位 |

### PRIORITY 常量

| 常量 | 值 | 用途 |
|---|---|---|
| `PRIORITY.FIRST` | `10` | 最先执行，用于角色卡注入、权限门禁 |
| `PRIORITY.EARLY` | `20` | 较早执行，用于记忆召回、情感解析、TTS 累积 |
| `PRIORITY.DEFAULT` | `100` | 默认值，大多数处理器使用此级别 |
| `PRIORITY.LATE` | `200` | 最后执行，用于遥测、审计日志 |

**实现细节**：`PRIORITY` 使用 `as const` 断言，确保所有值在类型层面被推导为字面量类型，而不是宽泛的 `number`。自定义优先级数字也完全支持。

---

## 二、`events.ts` —— 事件与 Payload 类型

### `HookEvent` 类型

定义了全部 11 个事件名称的联合类型：

```ts
type HookEvent =
  | 'beforeLlm' | 'afterLlmComplete'
  | 'afterMessage' | 'beforeToolUse' | 'afterToolUse'
  | 'onToolFailure' | 'beforeCompact' | 'afterCompact'
  | 'onTurnStart' | 'onTurnEnd' | 'onTurnAbort';
```

所有事件均为 turn（回合）级别。App 层级的通知（角色卡切换、情绪变化）由各自 package 通过简单回调/emitter 处理，不经过 HookBus。

### `HookPayload` 接口

一个映射类型，将每个事件名称映射到其对应的 payload 类型。这是此包的类型安全基础——`HookBus` 利用该映射来实现：当你触发 `'beforeLlm'` 时，处理器收到的 `ctx.payload` 会被自动推导为 `{ systemPrompt: string; messages: LlmMessage[] }`。

---

### 各事件详细说明

#### LLM 生命周期

| 事件 | Payload | 触发时机 | 说明 |
|---|---|---|---|
| `beforeLlm` | `{ systemPrompt: string; messages: LlmMessage[] }` | 发送请求给 LLM 之前 | **串行专用事件**（不支持并行）。处理器可以修改 system prompt 和消息列表。典型用途：注入角色卡、记忆、上下文。 |
| `afterLlmComplete` | `{ content: string; toolCalls?: unknown[] }` | LLM 响应完全接收后 | **支持并行**。`content` 是完整响应文本，`toolCalls` 可选，包含任何工具调用请求。 |

流式文本 delta 不走 HookBus。需要消费 `output_text_delta` 的长生命周期 sidecar（例如 TTS）由 apps/core orchestrator 直接订阅 engine event stream，避免高频、有状态、需保序的管线被 HookBus 并行语义打乱。

#### 工具生命周期

| 事件 | Payload | 触发时机 | 说明 |
|---|---|---|---|
| `beforeToolUse` | `{ callId: string; name: string; args: unknown }` | 工具调用之前 | **串行专用事件**。可以在此修改工具参数或阻止调用（返回 abort）。 |
| `afterToolUse` | `{ callId: string; name: string; output: unknown }` | 工具调用成功之后 | **支持并行**。用于记录、后处理工具输出。 |
| `onToolFailure` | `{ callId: string; name: string; error: unknown }` | 工具调用抛出错误时 | **支持并行**。用于错误处理、日志记录。 |

#### 消息与压缩

| 事件 | Payload | 触发时机 | 说明 |
|---|---|---|---|
| `afterMessage` | `{ messageId: MessageId; role: string; content: string }` | 消息被追加到对话后 | **支持并行**。用于消息后处理、持久化。 |
| `beforeCompact` | `{ messageCount: number; tokenEstimate: number }` | 上下文压缩前 | **串行专用事件**。可以基于 token 估计来决定是否压缩。 |
| `afterCompact` | `{ before: number; after: number; method: string }` | 上下文压缩后 | **支持并行**。`before` 和 `after` 记录压缩前后的消息数。 |

#### 回合生命周期

| 事件 | Payload | 触发时机 | 说明 |
|---|---|---|---|
| `onTurnStart` | `{ mode: TurnMode; subMode?: string }` | 回合开始时 | **串行专用事件**。可在此时做权限检查、模式切换。 |
| `onTurnEnd` | `{ durationMs: number }` | 回合结束时 | **支持并行**。用于记录回合耗时、统计。 |
| `onTurnAbort` | `{ reason: string }` | 回合被中止时 | **支持并行**。用于清理资源、记录中止原因。 |

---

### 并行支持情况总结

**支持并行的事件（7 个）**：

`afterLlmComplete`、`afterMessage`、`afterToolUse`、`onToolFailure`、`afterCompact`、`onTurnEnd`、`onTurnAbort`

这些都是**观察者风格**的事件（事后通知），处理器通常不需要修改状态。

**仅支持串行的事件（4 个）**：

`beforeLlm`、`beforeToolUse`、`beforeCompact`、`onTurnStart`

这些都是**前置事件**，处理器需要能够修改 payload（返回 `replace`）来影响后续流程。

---

## 三、`bus.ts` —— HookBus 核心实现

### 导出的接口/类型

#### `HookContext<E>`

传递给每个处理器的上下文对象。

| 字段 | 类型 | 说明 |
|---|---|---|
| `event` | `E` | 当前触发的事件名 |
| `turnId` | `TurnId` | 当前回合 ID |
| `sessionId` | `SessionId` | 当前会话 ID |
| `payload` | `HookPayload[E]` | 当前 payload（可能已被前面的处理器修改） |
| `meta` | `Record<string, unknown>` | 调用者拥有的暂存对象，在同一 `trigger()` 调用中跨所有处理器共享 |

**`meta` 的生命周期**：
- HookBus **不管理** `meta` 的生命周期。
- 复用同一个对象跨多次 `trigger()` 调用 → 实现回合级别的元数据共享。
- 每次 `trigger()` 传入新对象 → 实现调用级别的隔离。

#### `HookResult<E>`

单个处理器返回结果的判别联合类型：

| 变体 | 含义 |
|---|---|
| `{ kind: 'continue' }` | 处理完成，继续下一个处理器 |
| `{ kind: 'replace'; payload: HookPayload[E] }` | 替换当前 payload（仅串行处理器可用） |
| `{ kind: 'abort'; reason: string }` | 立即中止整个触发链 |

#### `HookTriggerResult<E>`

`trigger()` 返回结果的判别联合类型：

| 变体 | 字段 |
|---|---|
| `{ kind: 'continue'; payload: HookPayload[E]; warnings: HookWarning[] }` | 所有处理器正常完成（或非关键失败被记录为警告）。`payload` 是最终 payload。 |
| `{ kind: 'abort'; reason: string; payload: HookPayload[E]; warnings: HookWarning[] }` | 触发链被中止。`payload` 是中止时的 payload。 |

#### `HookHandler<E>`

处理器函数类型签名：

```ts
type HookHandler<E extends HookEvent> = (
  ctx: HookContext<E>,
) => Promise<HookResult<E>> | HookResult<E>;
```

支持同步和异步处理器。

#### `HookWarning`

非关键处理器失败时的警告信息：

| 字段 | 类型 | 说明 |
|---|---|---|
| `event` | `HookEvent` | 发生失败的事件 |
| `hook` | `string` | 处理器的名称 |
| `reason` | `string` | 失败原因（来自 `error.message`） |

#### `HookOptions`

`register()` 的配置选项：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `priority` | `number` | `100` | 执行顺序，数字越小越先执行 |
| `name` | `string` | 函数名或 `'<anonymous>'` | 便于调试和 `list()` 输出的名称 |
| `critical` | `boolean` | `true` | 为 `true` 时，处理器抛出错误会中止链；为 `false` 时，错误被记录为警告并继续执行 |
| `parallel` | `boolean` | `false` | 是否请求并行执行。如果事件不支持并行则忽略 |

#### `HookBusOptions`

`new HookBus()` 的配置选项：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `maxConcurrency` | `number` | `Infinity` | 并行处理器的最大并发数。必须 ≥ 1 |
| `parallelEvents` | `ReadonlySet<HookEvent>` | `DEFAULT_PARALLEL_EVENTS` | 允许并行执行的事件集合 |
| `traceSink` | `(entry: HookTraceEntry) => void` | `undefined` | 每次 handler 执行完毕后回调（无论成功/失败）。用于结构化日志、遥测、诊断面板。 |
| `warnAnonymous` | `boolean` | `false` | 为 `true` 时，注册匿名 handler 会在控制台打印警告。建议 dev 环境开启。 |

#### `HookTraceEntry`

`traceSink` 回调收到的单次执行记录：

| 字段 | 类型 | 说明 |
|---|---|---|
| `event` | `HookEvent` | 触发的事件名 |
| `handlerName` | `string` | 处理器名称 |
| `durationMs` | `number` | 执行耗时（毫秒） |
| `result` | `'continue' \| 'replace' \| 'abort' \| 'error'` | 执行结果 |
| `reason` | `string?` | 仅在 abort/error 时有值，描述原因 |
| `payloadReplaced` | `boolean` | handler 是否返回了 `replace` |

#### `RegisteredHook`

`list()` 返回的已注册 hook 元数据：

| 字段 | 类型 | 说明 |
|---|---|---|
| `event` | `HookEvent` | 事件名 |
| `name` | `string` | 处理器名称 |
| `priority` | `number` | 优先级 |
| `critical` | `boolean` | 是否关键 |
| `parallel` | `boolean` | 是否并行 |

---

### 内部实现详解

#### 内部类型

```ts
// 存储每个已注册处理器的完整信息（不导出）
interface HandlerEntry<E extends HookEvent> {
  event: E;
  handler: HookHandler<E>;
  priority: number;
  name: string;
  critical: boolean;
  parallel: boolean;
}

// 批次类型：串行批或并行批
type HookBatch<E extends HookEvent> =
  | { kind: 'serial'; entries: HandlerEntry<E>[] }
  | { kind: 'parallel'; entries: HandlerEntry<E>[] };
```

#### 默认并行事件集

硬编码了 7 个支持并行的事件：

```ts
const DEFAULT_PARALLEL_EVENTS = new Set<HookEvent>([
  'afterLlmComplete',
  'afterMessage',
  'afterToolUse',
  'onToolFailure',
  'afterCompact',
  'onTurnEnd',
  'onTurnAbort',
]);
```

#### 辅助函数

| 函数 | 说明 |
|---|---|
| `errorToReason(err)` | 将任意错误转为字符串，如果是 `Error` 实例取其 `message`，否则 `String(err)` |
| `chunkArray(items, size)` | 将数组按 `size` 大小分块。`size <= 0` 时抛出错误。 |
| `buildBatches(entries, eventAllowsParallel)` | 将处理器列表转为批次列表。连续的可并行处理器合并为一个并行批次，每个不可并行的处理器形成独立串行批次。 |

#### `buildBatches` 核心逻辑

遍历按优先级排序后的处理器列表：
1. 判断当前处理器是否可并行：`eventAllowsParallel && entry.parallel` 两者皆真才可并行。
2. 如果可并行：
   - 上一个批次也是并行批 → 合并到上一个批次。
   - 否则 → 创建新的并行批次。
3. 如果不可并行 → 创建新的串行批次（每个串行处理器一个独立批次）。

这样保证了**串行处理器不会被批量执行**，而**连续的并行处理器会合并为一个批次**并发执行。

---

### `HookBus` 类 API

#### 构造函数 `constructor(options?: HookBusOptions)`

```ts
constructor(options: HookBusOptions = {}) {
  this.maxConcurrency = options.maxConcurrency ?? Number.POSITIVE_INFINITY;
  this.parallelEvents = options.parallelEvents ?? DEFAULT_PARALLEL_EVENTS;

  if (this.maxConcurrency <= 0) {
    throw new Error(
      `maxConcurrency must be greater than 0, got ${this.maxConcurrency}`,
    );
  }
}
```

- 存储 `maxConcurrency` 和 `parallelEvents`。
- 校验 `maxConcurrency > 0`，否则抛出错误。
- 注册表 `registry` 初始化为空 `Map<HookEvent, HandlerEntry[]>`。

---

#### `register(event, handler, opts?): () => void`

注册一个事件处理器。

**实现流程**：

1. 构建 `HandlerEntry`，合并默认值：
   - `priority` 未指定时使用 `PRIORITY_DEFAULT` (100)
   - `name` 未指定时使用函数名（匿名函数用 `'<anonymous>'`）
   - `critical` 默认为 `true`
   - `parallel` 默认为 `false`
2. 如果该事件还没有注册列表，创建空数组。
3. 将条目追加到数组末尾，然后**按优先级升序排列**。
4. 返回一个**取消注册函数**：调用它时通过 `indexOf + splice` 从数组中移除该条目。

**关键实现细节**：TypeScript 无法在普通 `Map<HookEvent, HandlerEntry<HookEvent>[]>` 中保留 `HookEvent` 和 `HandlerEntry<E>` 之间的泛型关联，因此条目以**擦除类型**的方式存储（`as unknown as HandlerEntry<HookEvent>`），在 `trigger()` 时再通过相同方式恢复类型。

---

#### `trigger(event, ctx): Promise<HookTriggerResult<E>>`

触发一个事件的所有已注册处理器。

**完整执行流程**：

1. **获取处理器列表**：从 `registry` 获取该事件的处理器（可能为空数组）。

2. **无处理器则直接返回**：如果没有注册任何处理器，返回 `{ kind: 'continue', payload: 原始payload, warnings: [] }`。

3. **构建 baseCtx**：合并传入的 ctx 和 event，创建基础上下文。

4. **构建批次**：调用 `buildBatches(entries, eventAllowsParallel)` 将处理器列表转为批次列表。

5. **逐一处理批次**：
   - **串行批次**：
     - 逐个调用 `runOne()`。
     - 如果返回 `abort` → 立即返回，携带中止原因和当前 payload。
     - 如果返回 `replace` → 更新 `currentPayload` 为新的 payload。
     - 如果返回 `continue` → 处理下一个。
   - **并行批次**：
     - 调用 `runParallelBatch()`。
     - 如果返回 `abort` → 立即返回。
     - 并行处理器**不能修改** payload（见下方规则）。

6. **全部完成**：返回 `{ kind: 'continue', payload: currentPayload, warnings }`。

**关键规则**：
- ✅ 串行处理器可以 `replace` payload，下游处理器会看到修改后的值。
- ❌ 并行处理器不能返回 `replace`（返回则根据 `critical` 中止或警告）。
- 🛑 任何处理器返回 `abort` 都立即中止整个链条（无论 `critical` 设置）。
- ⚠️ `critical: false` 的处理器抛出错误，记录为 `HookWarning` 并继续执行。
- 💥 `critical: true`（默认）的处理器抛出错误，中止链条。

---

#### `runOne(event, entry, baseCtx, payload, warnings): Promise<HookResult<E>>`

执行单个处理器（串行或并行皆调用此方法）。

**实现细节**：
1. 构建 `handlerCtx`：将 `baseCtx` 与当前的 `payload` 合并，确保处理器拿到的是最新的 payload。
2. `try` 执行 `entry.handler(handlerCtx)`，支持同步和异步返回值。
3. `catch` 捕获异常：
   - 使用 `errorToReason()` 将异常转为字符串。
   - 如果是关键处理器：返回 `{ kind: 'abort', reason }`。
   - 如果是非关键处理器：将 `{ event, hook: entry.name, reason }` 推入 `warnings` 数组，返回 `{ kind: 'continue' }`。

---

#### `runParallelBatch(event, entries, baseCtx, payload, warnings)`

并行执行一批处理器。

**实现细节**：

1. **分块**：使用 `chunkArray(entries, maxConcurrency)` 将并行处理器按最大并发数分组。每块内的处理器同时运行，块与块之间串行。

2. **逐块处理**：
   - 使用 `Promise.allSettled` 并发执行块内所有处理器（每个都通过 `runOne` 执行）。
   - 处理 `allSettled` 结果：
     - `rejected`：这是防御性回退（因为 `runOne` 已经 catch 了），如果发生则按 critical 规则处理。
     - `kind === 'abort'`：立即返回中止结果。
     - `kind === 'replace'`：并行处理器不允许替换 payload → 如果 `critical` 则中止，否则记录警告。
     - `kind === 'continue'`：无操作。

3. 所有块完成后返回 `{ kind: 'continue' }`。

**重要**：并行处理器收到的 payload 是**批次开始时的快照**，处理器之间的 payload 修改不会在并行块中互相可见。

---

#### `list(event?: HookEvent): RegisteredHook[]`

列出已注册的 hook 元数据。

- 如果提供了 `event`：返回该事件下所有处理器的元数据，按优先级排序。
- 如果不提供 `event`：返回所有事件的所有处理器元数据，全局按优先级排序。

**用途**：调试、可观测性、在 UI 中展示已注册中间件列表。

---

### 处理器执行规则总结

| 规则 | 详情 |
|---|---|
| **优先级排序** | 处理器按优先级升序执行。同优先级内保持注册顺序。 |
| **批次构建** | 连续的 `parallel: true` 处理器（且事件支持并行）合并为一个并行批次；否则各自形成串行批次。 |
| **串行可修改 payload** | 串行处理器返回 `replace` 会更新 payload，下游处理器均可见。 |
| **并行不可修改 payload** | 并行处理器返回 `replace` 被视为错误（critical 则中止，否则警告）。 |
| **abort 是终局** | 任何处理器返回 `abort` 立即中止整个链条，不论 `critical` 设置。 |
| **critical 错误中止** | `critical: true`（默认）的处理器抛出异常，中止链条。 |
| **非 critical 错误警告** | `critical: false` 的处理器抛出异常，记录 `HookWarning` 并继续。 |
| **并发控制** | 并行批次按 `maxConcurrency` 分块执行，块内并发，块间串行。 |

---

## 四、`index.ts` —— 统一导出

此文件聚合所有公开 API：

```ts
export { HookBus } from './bus.js';
export { PRIORITY, PRIORITY_DEFAULT } from './priority.js';

export type { HookEvent, HookPayload } from './events.js';
export type {
  HookContext, HookHandler, HookResult, HookTriggerResult,
  HookWarning, HookOptions, HookBusOptions, RegisteredHook,
  HookTraceEntry,
} from './bus.js';
```

消费者只需 `import { HookBus, PRIORITY } from '@ema-agent/hook'` 即可使用。

---

## 五、`bus.test.ts` —— 测试文件分析

使用 **Vitest** 测试框架，共 **21 个测试用例**，覆盖以下场景：

### 基础功能测试

| 测试用例 | 测试内容 |
|---|---|
| `runs serial handlers in priority order` | 验证串行处理器按优先级顺序执行。注册 3 个不同优先级（FIRST、EARLY、DEFAULT）的处理器，检查执行顺序为 `[1, 2, 3]`，且最终返回 `continue` + 原始 payload。 |
| `returns continue with original payload when no handlers are registered` | 未注册任何处理器时，`trigger()` 应返回 `continue` + 原始 payload + 空 warnings。 |

### 中止机制测试

| 测试用例 | 测试内容 |
|---|---|
| `stops chain when a handler returns abort` | 第一个处理器返回 `abort`，验证后续处理器**未被调用**，触发结果包含 `abort` 和 `reason`。 |
| `treats thrown error from critical hook as abort` | 关键处理器（默认 `critical: true`）抛出 `Error('boom')`，触发结果应为 `abort`，reason 为 `'boom'`。 |
| `continues and records warning when non-critical hook throws` | 非关键处理器（`critical: false`）抛出错误后，验证：(1) 后续处理器仍被调用，(2) 结果中有 warning 记录，(3) 触发结果为 `continue`。 |

### 取消注册测试

| 测试用例 | 测试内容 |
|---|---|
| `unregisters handler` | 注册处理器后立即调用 `unregister()`，验证该处理器不再被调用，结果相当于未注册。 |

### Payload 修改测试（串行）

| 测试用例 | 测试内容 |
|---|---|
| `serial replace updates payload for subsequent handlers` | 第一个处理器返回 `replace` 修改 `systemPrompt`，验证第二个处理器收到的 `ctx.payload.systemPrompt` 是修改后的值。 |
| `serial multiple replace returns final payload` | 两个处理器依次追加 `systemPrompt`（" + memory" 和 " + persona"），验证最终 payload 为 "base + memory + persona"。 |
| `serial hook after parallel batch sees unchanged payload` | 并行批次（不修改 payload）+ 后面的串行批次（修改 payload）。验证串行处理器收到的是原始 payload，最终 payload 被正确修改。 |

### Meta 共享测试

| 测试用例 | 测试内容 |
|---|---|
| `keeps meta shared across handlers in the same trigger call` | 第一个处理器在 `ctx.meta` 上设置 `started = true`，验证第二个处理器能读到该值，且原始 `meta` 对象也被修改。 |

### 并行执行测试

| 测试用例 | 测试内容 |
|---|---|
| `ignores parallel option when event does not support parallel execution` | 对不支持的串行事件（`beforeLlm`）设置 `parallel: true`，验证处理器**仍然串行执行**（order 为 `['A', 'B']`，且 A 休眠 20ms 后 B 才执行）。 |
| `runs parallel hooks concurrently when event supports parallel execution` | 对支持并行的事件（`afterLlmComplete`）注册两个并行处理器（一个慢 30ms，一个快 5ms），验证执行顺序为 `['fast', 'slow']`（快的先完成）。 |
| `respects maxConcurrency for parallel hooks` | 设置 `maxConcurrency: 1`，两个并行处理器应依次执行（`['A', 'B']`），验证并发限制生效。 |

### 混合串行/并行批次测试

| 测试用例 | 测试内容 |
|---|---|
| `runs mixed serial and parallel batches in registration order within the same priority` | 同优先级下注册 4 个处理器：串行-A、并行-B、并行-C、串行-D。验证执行顺序为：串行-A → 并行-C+并行-B 并发 → 串行-D。并行中快的先完成。 |

### 并行替换/中止边界测试

| 测试用例 | 测试内容 |
|---|---|
| `parallel hook returning replace aborts when critical` | 关键并行处理器返回 `replace`（不允许的操作），验证触发结果为 `abort`，reason 包含明确说明。 |
| `parallel hook returning replace records warning when non-critical` | 非关键并行处理器返回 `replace`，验证触发结果为 `continue`（成功 continuation），但有 warning 记录。 |
| `parallel hook returning abort aborts trigger even when non-critical` | 非关键并行处理器返回 `abort`，验证整个触发链中止。注意：因为是并行批，其他处理器可能已经执行（`reached` 被调用 1 次）。 |
| `parallel critical throw aborts trigger` | 关键并行处理器抛出错误，验证触发结果中止，reason 为错误消息。 |
| `parallel non-critical throw records warning and continues` | 非关键并行处理器抛出错误，验证：(1) 其他并行处理器正常执行，(2) 有 warning 记录，(3) 触发结果为 `continue`。 |

### 列表与校验测试

| 测试用例 | 测试内容 |
|---|---|
| `list returns registered hook metadata in priority order` | 注册 2 个处理器后调用 `list('beforeLlm')`，验证返回的元数据按优先级排序、包含所有字段。 |
| `throws when maxConcurrency is invalid` | `maxConcurrency: 0` 和 `maxConcurrency: -1` 都应抛出错误。 |

---

## 设计要点

1. **类型擦除是刻意的**：由于 TypeScript 不支持在 `Map<K, V>` 中保持 `K` 和 `V` 之间的泛型关联（即不支持 "correlated generics"），`HookBus` 在存储时擦除 `HandlerEntry<E>` 为 `HandlerEntry<HookEvent>`，在 `trigger()` 时通过断言恢复。这已通过全面的测试保证类型安全。

2. **并行处理器只能观察**：并行事件（如 `afterLlmComplete`）通常用于遥测、日志、多个观察者。由于这些处理器并发运行，它们不能安全地修改共享 payload，因此返回 `replace` 被禁止。

3. **`meta` 生命周期由调用者决定**：`HookBus` 完全透传 `meta` 对象，不创建、不复制、不清理。这给予调用者最大的灵活性来管理跨回合或单次调用的中间状态。

4. **Priority 数字设计**：使用连续数字而非枚举，允许在预定义槽位之间插入自定义优先级，非常灵活。
