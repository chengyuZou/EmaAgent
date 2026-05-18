# EmaAgent Phase 2A — 开发报告

> 开发周期：2026-05-17 中午 ~ 2026-05-18 01:27（上海时间）  
> 主题：ConversationEngine + Narrative RAG 管线全链路实现与调试

---

## 一、本阶段目标

在已有的底座包（`hook` / `session` / `llm` / `storage`）之上，完整打通：

1. **`packages/conversation/`** — 独立的对话引擎包，同时服务 core HTTP sidecar 与未来 CLI
2. **Narrative RAG 管线** — 路由 → 并发检索 → 流式事件 → LLM 上下文注入
3. **4 个已知 Bug 修复**（详见第四节）
4. **Bridge 端修复**：`config.py` camelCase/snake_case 不匹配、`asyncio.gather` 全失败逻辑、新增 Ingest 接口

---

## 二、文件清单

### 新建文件

| 文件 | 说明 |
|------|------|
| `packages/conversation/package.json` | 独立包声明，依赖 contracts/llm/session/hook/emotion/narrative-client/storage |
| `packages/conversation/tsconfig.json` | extends `../../tsconfig.base.json` |
| `packages/conversation/src/types.ts` | `ConversationDeps`、`ConversationRunInput` 接口 |
| `packages/conversation/src/engine.ts` | `ConversationEngine` 类 + `runTurn` + `streamingBeforeLlm` |
| `packages/conversation/src/hooks.ts` | `registerConversationHooks`（`narrative:recall` hook） |
| `packages/conversation/src/index.ts` | 包公共导出 |
| `test_narrative_e2e.py` | 端到端测试脚本（DeepSeek + SiliconFlow） |

### 修改文件

| 文件 | 改动摘要 |
|------|---------|
| `packages/contracts/src/events.ts` | 新增 `narrative_route_resolved`、`narrative_timeline_complete` 两个事件类型 |
| `packages/narrative-client/src/types.ts` | 新增 `NarrativeIngestRequest`、`NarrativeIngestResponse` |
| `packages/narrative-client/src/client.ts` | 新增 `queryOne()`、`ingest()`；`AbortSignal.any()` 组合超时+用户中止；`updateBaseUrl()` 热更新 |
| `apps/core/src/orchestrator/orchestrator.ts` | 重写为调用 `ConversationEngine`，chat/narrative 共用同一路径 |
| `apps/core/src/orchestrator/conversation-flow.ts` | 精简为纯 re-export shim |
| `apps/core/src/wiring.ts` | 调用 `registerConversationHooks` 完成 hook 注册 |
| `apps/core/package.json` | 新增 `@ema-agent/conversation: workspace:*` 依赖 |
| `apps/bridge/bridge/config.py` | 修复 camelCase/snake_case 不匹配，加 `alias_generator=to_camel` |
| `apps/bridge/bridge/narrative/manager.py` | 修复 `asyncio.gather` 全失败逻辑；新增 `ingest()` 方法 |
| `apps/bridge/bridge/routes/narrative.py` | 新增 `POST /narrative/ingest` 路由 |

---

## 三、架构说明

### 3.1 整体数据流

```
用户输入 (POST /api/turns)
    │
    ▼
Orchestrator.run()
    │  startTurn() → 拿到 turn + AbortSignal
    ▼
ConversationEngine.run()          ← packages/conversation
    │
    ├─ onTurnStart hook
    │
    ├─ streamingBeforeLlm()       ← 并发事件流关键点
    │       │
    │       ├─ prompts:buildSystem (priority 10)
    │       │     └─ 注入系统提示到 messages 头部
    │       │
    │       └─ narrative:recall   (priority 5，先于 buildSystem 执行)
    │             │
    │             ├─ bridge POST /narrative/route  (LLM路由)
    │             │     └─ emit: narrative_route_resolved
    │             │
    │             ├─ 并发 N × bridge POST /narrative/query
    │             │     └─ 每完成一个 emit: narrative_timeline_complete
    │             │
    │             └─ 注入 [NARRATIVE CONTEXT] user message
    │                   └─ emit: recall_evidence
    │
    ├─ LLM stream (逐 delta)
    │     ├─ emotion.processChunk() → 剥离 ACT 标签
    │     ├─ emit: output_text_delta
    │     └─ afterLlmDelta hook (TTS 等)
    │
    ├─ afterLlmComplete / afterMessage / onTurnEnd hooks
    │
    └─ emit: turn_completed
```

### 3.2 Hook 优先级设计

```
beforeLlm 执行顺序（数字越小越先）：

  priority 5  — narrative:recall   (packages/conversation/hooks.ts)
                  ↳ 需要在 system prompt 注入前跑，这样 recall context
                    会插入到 messages 列表里，而不是被 system prompt 覆盖

  priority 10 — prompts:buildSystem (apps/core/wiring.ts)
                  ↳ 在所有内容确定后，把 system prompt 插到 messages[0]
```

两个 hook 都返回 `{ kind: 'replace', payload: { messages: [...] } }`，HookBus 串行应用，最终 messages 结构为：

```
[ system ]  ← buildSystem 注入
[ user ]    ← [NARRATIVE CONTEXT ...] recall 注入
[ user ]    ← 用户原始输入（始终保持最后）
```

### 3.3 `streamingBeforeLlm` — 并发事件桥接模式

这是本阶段最核心的技术点。问题：

- `hooks.trigger('beforeLlm')` 是 async 函数，需要 `await` 才能拿到结果
- 但 hook 内部在执行期间会调用 `ctx.emit(event)` 发出中间事件
- `runTurn` 是 `AsyncGenerator`，必须能 `yield` 这些中间事件

如果直接 `await hooks.trigger()`，中间事件会全部堆积，等 hook 执行完才能 yield，前端看到的效果是所有周目同时完成，不是渐进渲染。

**解决方案**：`streamingBeforeLlm` — 把 trigger 作为后台任务运行，通过 notify/queue 模式桥接：

```typescript
async function* streamingBeforeLlm(
  hooks: HookBus,
  ctx: Omit<HookContext<'beforeLlm'>, 'event' | 'emit'>,
): AsyncGenerator<EmaStreamEvent, HookTriggerResult<'beforeLlm'>> {
  const queue: EmaStreamEvent[] = [];
  let notify: (() => void) | null = null;
  let done = false;
  let result!: HookTriggerResult<'beforeLlm'>;
  let error: unknown;

  // emit 被同步调用时：推入队列，唤醒等待的 generator
  const emit = (ev: EmaStreamEvent) => {
    queue.push(ev);
    notify?.();
    notify = null;
  };

  // trigger 在后台跑，完成时设 done + 唤醒
  hooks.trigger('beforeLlm', { ...ctx, emit }).then(
    (r) => { result = r; done = true; notify?.(); notify = null; },
    (e: unknown) => { error = e; done = true; notify?.(); notify = null; },
  );

  // generator 主循环：有事件就 yield，否则挂起等 notify
  while (!done || queue.length > 0) {
    while (queue.length > 0) yield queue.shift()!;
    if (!done) await new Promise<void>((r) => { notify = r; });
  }

  if (error !== undefined) throw error as Error;
  return result;  // ← AsyncGenerator 的返回值，yield* 的表达式值
}
```

调用侧：

```typescript
// yield* 同时做两件事：
//   1. 把 generator 产出的 EmaStreamEvent 逐个透传给外层 generator
//   2. 捕获 generator 的 return 值作为表达式结果
const llmHookResult = yield* streamingBeforeLlm(hooks, { ... });
```

这是 TypeScript 中少见的用法：`yield*` 作用于一个有非 void 返回类型的 `AsyncGenerator<Y, R>`，表达式的值就是 `R`。

### 3.4 Narrative RAG 并发检索

```typescript
// hooks.ts — narrative:recall
await Promise.allSettled(
  Object.entries(routeResp.routes).map(async ([timeline, query]) => {
    try {
      const text = await deps.narrative.queryOne(timeline, query, signal);
      ctx.emit?.({ type: 'narrative_timeline_complete', timeline, charCount: text.length, snippet: ... });
      if (text.trim().length > 0) recallParts.push([timeline, text]);
    } catch (err) {
      if (err instanceof NarrativeUnavailableError) throw err;  // 上浮，触发外层降级
      ctx.emit?.({ type: 'system_warning', ... });              // 单周目失败不影响其他
    }
  }),
);

// 按路由顺序排（Promise.allSettled 完成顺序不确定）
const routeOrder = Object.keys(routeResp.routes);
recallParts.sort(([a], [b]) => routeOrder.indexOf(a) - routeOrder.indexOf(b));
```

`queryOne` 本质是：

```typescript
async queryOne(timeline, query, signal) {
  const resp = await this.query({ [timeline]: query }, 'hybrid', signal);
  return resp.results[timeline] ?? '';
}
```

每个周目发独立的 HTTP 请求，而不是一次批量请求。这是让前端可以看到"第三周目先完成"效果的关键——如果用 `query_batch`，Python 侧 `asyncio.gather` 会等所有周目都完成才返回。

### 3.5 Bridge 端：`asyncio.gather` 部分失败处理

```python
# manager.py
settled = await asyncio.gather(
    *(_one(t, q) for t, q in valid.items()),
    return_exceptions=True,   # ← 不因单个失败而全部取消
)
results: dict[str, str] = {}
errors: list[BaseException] = []
for item in settled:
    if isinstance(item, BaseException):
        errors.append(item)
        continue
    timeline, text = item
    results[timeline] = text

# 只有全部失败才上浮第一个错误，让调用方拿到 500
if errors and not results:
    raise errors[0]
return results
```

### 3.6 AbortSignal 组合

```typescript
// narrative-client/client.ts
private post(path, body, externalSignal?) {
  const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
  const signal = externalSignal
    ? AbortSignal.any([timeoutSignal, externalSignal])  // 任一触发即中止
    : timeoutSignal;
  return fetch(url, { method: 'POST', body: ..., signal });
}
```

`AbortSignal.any()` 是 Node 20 原生 API，不需要第三方库。用户 stop（外部 signal）或超时（60s）都能中止进行中的 bridge 请求。

---

## 四、Bug 修复记录

### Bug 1 — `onTurnStart` hook abort 未 yield `turn_failed`

**现象**：`onTurnStart` 返回 `{ kind: 'abort' }` 时，session 被 fail 但 SSE 流没有发出任何事件，前端永久等待。

**修复**：

```typescript
if (startResult.kind === 'abort') {
  session.failTurn(turnId, 'turn/hook_aborted', startResult.reason);
  yield { type: 'turn_failed', turnId, code: 'turn/hook_aborted', message: startResult.reason };
  return;
}
```

---

### Bug 2 — 用户中止 vs 后流错误的误判

**现象**：LLM 流结束后，hook 执行出错，`catch` 里 `signal.aborted` 可能恰好为 true，误判为"用户主动停止"，turn 被 abort 而非 fail。

**修复**：增加 `llmStreamDone` flag：

```typescript
let llmStreamDone = false;
// ... for await (const chunk of stream) { ... }
llmStreamDone = true;  // 流正常结束后设置

// catch 里：
if (signal.aborted && !llmStreamDone) {
  // 真正的用户中止（流进行中）
  session.abortTurn(...);
  yield { type: 'turn_aborted', ... };
} else {
  // 后流错误，或 signal 碰巧 aborted
  session.failTurn(...);
  yield { type: 'turn_failed', ... };
}
```

---

### Bug 3 — `afterLlmDelta` hook 与 `afterLlmComplete` 竞争

**现象**：`afterLlmDelta` 是 fire-and-forget（没有 await），TTS 等慢 hook 可能在 `afterLlmComplete` 之后才处理最后几个 delta，产生乱序。

**修复**：收集所有 delta hook 的 Promise，在 `afterLlmComplete` 前统一 drain：

```typescript
const deltaPromises: Promise<unknown>[] = [];

// 流式处理中：
deltaPromises.push(hooks.trigger('afterLlmDelta', { ... }));

// 流结束后，先 drain，再 afterLlmComplete：
await Promise.allSettled(deltaPromises);
await hooks.trigger('afterLlmComplete', { ... });
```

---

### Bug 4 — `beforeLlm` 发出的事件被全部缓冲，无法渐进 yield

**现象**：原始设计用 `emitBuffer: EmaStreamEvent[]` 收集 hook 内 emit 的事件，等 hook 全部完成再统一 yield，导致所有周目结果同时出现。

**修复**：用 `streamingBeforeLlm` 替代（见 3.3 节），每次 `ctx.emit()` 调用都立即唤醒 generator yield，实现真正的渐进渲染。

---

## 五、Bridge Bug 修复

### Bug 5 — `config.py` camelCase/snake_case 不匹配（根本 Bug）

**现象**：TS `wiring.ts` 发送 `{ apiKey, baseUrl }` 给 `POST /internal/configure`，Python Pydantic 模型期待 `{ api_key, base_url }`，返回 422 Validation Error，被 `catch { return false }` 吞掉，bridge 从未真正被配置。所有 narrative 查询返回空。

**修复**：

```python
# config.py
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

class EmbedCfg(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    api_key:  str
    base_url: str
    model:    str
    dim:      int = 1024

class LlmCfg(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    api_key:  str
    base_url: str
    model:    str
```

`alias_generator=to_camel` 让 Pydantic 同时接受 `apiKey`（JSON 入参）和 `api_key`（Python 内部访问）。`populate_by_name=True` 保证两种写法都能用。

---

## 六、新增功能：Narrative Ingest

Bridge 原先只有 route + query，没有写入接口。新增三层：

**Python — `NarrativeManager.ingest()`**：

```python
async def ingest(self, timeline: str, documents: list[str]) -> int:
    rag = self._instances.get(timeline)
    if rag is None:
        return 0
    await rag.ainsert(documents)
    return len(documents)
```

**Python — `POST /narrative/ingest`**：

```python
@router.post("/ingest", response_model=IngestResponse)
async def ingest_narrative(body: IngestRequest) -> IngestResponse:
    if state.narrative_manager is None:
        raise _NOT_READY
    if body.timeline not in VALID_TIMELINES:
        raise HTTPException(status_code=422, ...)
    accepted = await state.narrative_manager.ingest(body.timeline, body.documents)
    return IngestResponse(accepted=accepted)
```

**TypeScript — `NarrativeClient.ingest()`**：

```typescript
async ingest(timeline, documents, signal?) {
  const body: NarrativeIngestRequest = { timeline, documents };
  const res = await this.post('/narrative/ingest', body, signal);
  await this.assertOk(res, 'ingest');
  return res.json() as Promise<NarrativeIngestResponse>;
}
```

---

## 七、SSE 事件协议（本阶段新增）

```typescript
// contracts/events.ts 新增

| { type: 'narrative_route_resolved'; timelines: string[] }
// 路由完成后立即发出，前端据此创建 N 个"检索中"状态块
// 只暴露周目名称，不暴露内部子查询

| { type: 'narrative_timeline_complete'; timeline: string; charCount: number; snippet: string }
// 某一周目 queryOne() 返回时发出
// snippet: 前100字符截断，CLI友好（不dump完整内容）
// charCount: 用于前端展示检索量
```

完整 narrative turn 的事件序列：

```
turn_started
narrative_route_resolved        { timelines: ["3rd_Loop"] }
narrative_timeline_complete     { timeline: "3rd_Loop", charCount: 60631, snippet: "..." }
recall_evidence                 { sources: ["3rd_Loop"], itemCount: 1 }
output_text_delta × N           (流式文本)
output_text_complete
turn_completed                  { usage: { inputTokens: 17474, outputTokens: 318 } }
```

---

## 八、端到端测试结果

**配置**：DeepSeek（deepseek-chat）+ SiliconFlow（Pro/BAAI/bge-m3，dim=1024）

**查询**：`第三周目里希罗揭露了哪些人的禁忌？`

**结果**：
- 路由正确识别 `3rd_Loop`
- LightRAG 返回 60,631 chars 知识图谱上下文（实体 + 关系 + chunks）
- LLM（17,474 input tokens）正确从图谱中提取出全部 13 个禁忌，含最终禁忌「旁观者」（艾玛）
- 完整事件序列符合预期

**发现的环境问题**（已修复）：
- `data/narrative/` 文件权限为只读，LightRAG 写缓存时 `PermissionError`
- 多个 bridge 进程占用不同端口（7421~7424），新进程监听错误端口

---

## 九、遗留事项 / 下一阶段

| 优先级 | 事项 |
|--------|------|
| P1 | `narrative_timeline_complete` 的 snippet 是原始 LightRAG 格式，前端渲染价值低 |
| P1 | `configureBridge` 失败静默（`catch { return false }`），建议加告警日志或重试 |
| P2 | Bridge 多实例端口冲突问题（建议写 `bridge.port` 文件后 core 侧动态读取） |
| P2 | Ingest 接口无鉴权（`EMA_SHARED_SECRET` 没有传入 bridge route 的 header 校验） |
| P3 | Narrative RAG token 消耗高（17K tokens/turn），可考虑在 bridge 侧做摘要压缩后再返回 |
