# @ema-agent/core-types

EmaAgent 全栈共享的类型契约层。前端、BFF、Runtime、仓储实现统一 `import type` 此包，保证接口一致性。

---

## 文件地图（13 文件）

| 文件 | 职责 | 产出物 |
|------|------|--------|
| `ids.ts` | 12 个 Brand 字符串 ID + `UnixMs` + `IsoDateTime` + `asId()` | 全包引用的基础类型 |
| `mode.ts` | 3 种执行模式 `chat \| agent \| narrative` + 选择状态 | `EmaMode`, `ModeSelectionState` |
| `session.ts` | 会话实体（已去除 messages[]）+ 摘要 + 仓储接口 | `SessionState`, `SessionSummary`, `SessionRepository` |
| `message.ts` | "一切皆区块"聊天流协议：10 种 `MessageContentBlock` | `ChatMessage`, `MessagePage` |
| `turn.ts` | 单轮回合发起/执行/持久化 + 仓储 | `StartTurnRequest`, `TurnRecord`, `TurnRepository` |
| `artifact.ts` | 产物类型/摘要/详情 + 仓储（代码、表格、diff、图表等） | `ArtifactSummary`, `ArtifactDetail`, `ArtifactRepository` |
| `event.ts` | 17 种 SSE 流事件 + `BaseEvent` | `SseEvent` 联合，`TurnStartedEvent` … `ImageEvent` |
| `memory.ts` | 四层记忆模型（L1-L4）+ Python Bridge + GraphRAG 占位 | `RecallResult`, `RollingSummary`, `ReflectionMemo` … |
| `model.ts` | Provider/Model 目录 + LLM ChatCompletion 底层协议 | `ProviderDescriptor`, `ModelDescriptor`, `ChatCompletionRequest` |
| `view.ts` | 8 个聚合视图（跨实体 join 的只读投影） | `DashboardView`, `SessionDetailView`, `ModelPickerView` … |
| `errors.ts` | UI 可理解的错误协议 + `EmaError` 基类 | `UiErrorView`, `toUiErrorView()` |
| `metadata.ts` | 版本信息 + 运行时环境 | `PackageVersion`, `RuntimeEnv` |
| `index.ts` | barrel 统一导出入口 | — |

---

## 数据流转全景图

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              EmaAgent 数据平面                                │
│                                                                              │
│  ┌────────────┐     HTTP POST        ┌──────────────┐                        │
│  │   前端 UI   │ ──────────────────▶  │    BFF 层     │                        │
│  │ (React)    │ ◀── SSE EventStream ─ │ (API Gateway) │                        │
│  └─────┬──────┘                      └──────┬───────┘                        │
│        │ 消费:                              │ 消费:                           │
│        │  view.ts   聚合视图                │  turn.ts   StartTurnRequest      │
│        │  event.ts  SSE 事件                │  session.ts SessionState         │
│        │  message.ts 消息区块               │  errors.ts UiErrorView          │
│        │                                    │                                 │
│        ▼                                    ▼                                 │
│  ┌──────────────────────────────────────────────────────────────┐            │
│  │                     @ema-agent/core-types                     │            │
│  │                     (纯类型层，零运行时)                        │            │
│  └──────────────────────────────────────────────────────────────┘            │
│                              ▲                                               │
│                              │                                               │
│                     ┌────────┴────────┐                                      │
│                     │                 │                                      │
│              ┌──────┴───────┐  ┌──────┴───────┐                              │
│              │  Runtime 层   │  │  仓储实现层   │                              │
│              │               │  │              │                              │
│              │ 消费:         │  │ 消费:        │                              │
│              │  model.ts     │  │  session.ts  │                              │
│              │  memory.ts    │  │  message.ts  │                              │
│              │  artifact.ts  │  │  turn.ts     │                              │
│              │  errors.ts    │  │  artifact.ts │                              │
│              └───────────────┘  └──────────────┘                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 单次 Turn 完整数据流

```
用户点击发送
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 1: 前端组装请求                                             │
│                                                                 │
│ StartTurnRequest {                                              │
│   sessionId, mode,                                              │
│   input: [ {type:"text", text:"帮我修复bug"},                    │
│            {type:"file_ref", attachmentId:...} ]                │
│ }                                                               │
│   → POST /api/turns                                              │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 2: BFF 创建 Turn + 返回 SSE URL                             │
│                                                                 │
│ StartTurnResponse { requestId, streamUrl }                       │
│   ← 200 + streamUrl                                              │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 3: 前端连接 SSE 流                                         │
│                                                                 │
│ EventSource(streamUrl)  开始接收 SseEvent 联合:                  │
│                                                                 │
│  ① TurnStartedEvent  { type:"turn_started", mode:"agent" }      │
│  ② StepStartEvent    { type:"step_start", title:"分析代码" }     │
│  ③ TextDeltaEvent    { type:"text_delta", delta:"我来" }        │
│  ④ TextDeltaEvent    { type:"text_delta", delta:"看看" }        │
│  ⑤ ToolCallStartEvent{ type:"tool_call_start", toolName:"read" }│
│  ⑥ ToolCallArgsEvent { type:"tool_call_args", argsDelta:"..." } │
│  ⑦ ToolCallEndEvent  { type:"tool_call_end" }                   │
│  ⑧ ToolResultEvent   { type:"tool_result", success:true }       │
│  ⑨ ArtifactCreateEvt { type:"artifact_create", summary:{...}}   │
│  ⑩ ArtifactDeltaEvt { type:"artifact_delta", delta:"..." }     │
│  ⑪ ArtifactFinalize  { type:"artifact_finalize" }               │
│  ⑫ TextDoneEvent     { type:"text_done", fullText:"..." }       │
│  ⑬ TurnCompletedEvt  { type:"turn_completed", usage:{...}}      │
│  ⑭ ErrorEvent        { type:"error", code:"tool_failed" }       │
│       (任意位置可插入错误)                                        │
│  ⑮ ImageEvent        { type:"image", url:"...", alt:"..." }     │
│       (模型生成的图片/图表)                                       │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 4: 前端渲染器逐事件消费                                     │
│                                                                 │
│ ChatMessage.contentBlocks[]  按到达顺序 append:                  │
│                                                                 │
│  [0] { type:"text", text:"我来看看这个bug" }                     │
│  [1] { type:"tool_call", toolCallId, toolName, args }           │
│  [2] { type:"tool_result", toolCallId, success, resultStr }     │
│  [3] { type:"artifact_ref", artifact: ArtifactSummary }         │
│  [4] { type:"text", text:"修复完成" }                            │
│                                                                 │
│ 渲染规则:                                                        │
│  • tool_call → 折叠卡片，点击展开参数 JSON                       │
│  • tool_result → 灰色小字，显示结果摘要                          │
│  • artifact_ref → 小卡片 (标题 + 打开按钮)                       │
│    点击打开 → 右侧 Canvas / 弹出浮窗显示完整代码/表格/diff       │
│  • image → 直接渲染 <img>                                        │
│  • permission_request → 红色/黄色确认按钮                        │
│  • error → 红色提示 + 重试按钮                                   │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 5: 用户打开产物 (Canvas 模式)                               │
│                                                                 │
│ 点击 artifact_ref 的"打开"按钮:                                  │
│  ① GET /api/artifacts/{artifactId}                              │
│     ← ArtifactDetail { summary, payload, binaryBase64? }        │
│                                                                 │
│  ② 右侧弹出独立窗口:                                             │
│     ┌─────────────────────────────────┐                         │
│     │ 顶部标题栏: Provider Errors  [🔗☁️📋] │                   │
│     │ ─────────────────────────────── │                         │
│     │   1 │ const x = 1              │                         │
│     │   2 │ ...                      │  代码/表格/diff 全屏显示  │
│     │   3 │ ...                      │                         │
│     └─────────────────────────────────┘                         │
│                                                                 │
│  ③ session 内的产物列表面板:                                     │
│     GET /api/sessions/{sid}/artifacts                           │
│     ← ArtifactListPanel { sessionId, items[], hasMore }          │
│     左侧显示所有产物卡片 (标题 + 种类图标 + 打开按钮)            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 记忆系统四层架构

```
┌─────────────────────────────────────────────────────────┐
│  LLM system prompt 组装（按 priority 截断）               │
│                                                         │
│  ┌──────────────────────────────────────────────┐       │
│  │         ContextBlock[] 注入                  │       │
│  │  recall → RecallResult { blocks[], meta }    │       │
│  └────▲─────▲────────▲────────▲─────────────────┘       │
│       │     │        │        │                         │
│   ┌───┘     │        │        └──────────┐              │
│   │    ┌────┘        │                   │              │
│   │    │        ┌────┘                   │              │
│   ▼    ▼        ▼                        ▼              │
│  L1   L2       L3                       L4              │
│ 工作台 对话摘要 会话身份                 跨会话画像       │
│ (内存) (JSON)  (JSON)             (SQLite/Python Bridge)│
│                          ┌────────────┴──────────┐     │
│                          │                       │     │
│                      UserProfile           WorldState  │
│                    (偏好/技能/习惯)     (剧情/时间线)    │
│                          │                       │     │
│                          ▼                       ▼     │
│                    SQLite 持久化        Python lightrag │
└─────────────────────────────────────────────────────────┘
```

---

## 前端 UI 八面板 → 类型映射

| 面板 | UI 描述 | 消费的核心类型 |
|------|---------|---------------|
| ① 两栏卡片网格 (Dashboard) | 深灰圆角卡片，标题+图标+状态灯 | `DashboardView`, `SessionListItem` |
| ② 混合选择面板 (Mode) | 横向小卡片 + 蓝色选中边框 + 搜索栏 | `ModeSelectionState`, `EmaMode` |
| ③④ 三栏卡片墙 (Provider) | 半透明水印图标 + 健康状态 | `ProviderDescriptor`, `ProviderHealthView` |
| ⑤ 通栏列表 (Settings) | 单列深灰长条 + 右侧水印图标 | `ProviderDescriptor[]`, `ModelDescriptor[]` |
| ⑥ 代码容器 (Canvas Code) | 代码编辑器窗口 + 标题栏 + 行号 | `ArtifactDetail`, `ArtifactKind:"code"` |
| ⑦ 文件清单浮窗 (Sidebar) | 抽屉式文件列表 + 图标 + 日期 | `WorkspaceFileListView`, `WorkspaceFileEntry` |
| ⑧ 组件列表 (Canvas List) | 胶囊形卡片 + 蓝色"打开"按钮 | `ModelPickerView`, `ProviderAction{primary}` |

---

## 类型设计原则

1. **Brand ID 管控所有标识符** — `SessionId` / `TurnId` / `ArtifactId` 等 12 种，杜绝 `string` 误用
2. **`UnixMs` 标注所有时间字段** — `number` 只用于纯计数（token 数、优先级）
3. **实体与仓储分离** — `SessionState` 是数据，`SessionRepository` 是契约
4. **聚合视图不进实体** — `DashboardView` 等只在 `view.ts`，消费方不需要知道 join 逻辑
5. **"一切皆区块"** — `ChatMessage.contentBlocks[]` 的 `MessageContentBlock` 联合体是前端渲染的唯一数据源
6. **事件自包含** — 每个 `SseEvent` 携带全部渲染所需字段，前端无需二次 fetch
7. **文件职责单一** — 一个文件一个领域，不交叉污染