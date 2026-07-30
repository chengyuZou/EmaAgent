# EmaAgent Chat 工作区与历史导航实施计划

> 状态：批次 B 已完成，TaskList、AgentRun 迁移与 Workspace Dock 尚未实现
> 日期：2026-07-23  
> 范围：Desktop Chat 主布局、Turn 快速导航、Task/AgentRun/来源展示、右侧与底部工作区、桌面打开方式  
> 不包含：恢复 Session Branch、尚无运行能力的空 Terminal/Browser/Review 面板
> 2026-07-29 补充：§3 各入口的交互细节已按 Codex App 实测行为校正（截图实证），与旧描述冲突处以补充段落为准。快捷键方案整体未定，任何界面先不写快捷键，后续单独一批统一设计。

## 1. 设计结论

EmaAgent Chat 不再使用“古早 Task、文件、Branch 固定检查器”的布局。目标结构分成四层：

1. **聊天主区**：历史消息、Turn 快速导航、当前执行状态、输入框；
2. **会话摘要**：工作区/Git、运行活动、来源的置顶浮层；
3. **工作标签**：同一套标签可以停靠到右侧或底部，同一资源只存在一个实例；
4. **桌面能力**：用已检测到的本机程序打开工作区，由 Tauri 按平台提供。

Branch 已从 V1 数据库、后端和前端删除，不能以 `conversationBranches` 标签或兄弟分支导航的形式重新进入工作区。保留的历史操作只有：

- Session 侧栏完整 Fork；
- 最终 assistant 回复下按 Turn 截止位置 Fork 为独立 Session；
- 最后一条用户消息回退并重新发送。

## 2. 总体布局

```text
┌──────────────────────────────── EmaAgent Desktop ────────────────────────────────┐
│                                                                                  │
│  ┌ SessionSidebar ┐ ┌──────────────────── WorkspaceFrame ──────────────────────┐ │
│  │                │ │ ChatHeader                                    RightDock │ │
│  │ 会话列表       │ │ [标题]       [在…中打开] [置顶摘要] [底部] [右侧]       │ │
│  │                │ ├───────────────────────────────────────────────┬──────────┤ │
│  │ 完整 Session   │ │ TurnRail │                                    │ [标签]   │ │
│  │ Fork           │ │          │ ChatHistory                        │          │ │
│  │                │ │  ─       │                                    │ Review / │ │
│  │                │ │  ───     │                                    │ Files /  │ │
│  │                │ │  ━━━━━   │                                    │ File /   │ │
│  │                │ │  ───     │                                    │ AgentRun │ │
│  │                │ │  ─       │                                    │ Sources  │ │
│  │                │ ├──────────┴────────────────────────────────────┴──────────┤ │
│  │                │ │ [Task 2/5]                         [改动 +38 -226]        │ │
│  │                │ │ [需要用户确认的 Permission / AskUser 卡片]               │ │
│  │                │ │ [ChatInput                                                ] │
│  │                │ ├──────────────────── BottomDock ──────────────────────────┤ │
│  │                │ │ [Terminal ×] [Review ×] [+]                              │ │
│  └────────────────┘ └───────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────┘
```

布局层级固定为：

```text
ChatPanel
└─ WorkspaceFrame
   ├─ MainRow
   │  ├─ ChatColumn
   │  │  ├─ ChatHeader
   │  │  ├─ ChatHistory
   │  │  │  ├─ TurnRail
   │  │  │  └─ MessageViewport
   │  │  ├─ TurnActivityStrip
   │  │  ├─ DecisionQueue
   │  │  ├─ ChatInput
   │  │  └─ StatusBar
   │  └─ RightDock
   └─ BottomDock
```

BottomDock 横跨 ChatColumn 与 RightDock。SessionSidebar 不被 BottomDock 覆盖。

## 3. 顶栏四个入口

```text
[在…中打开 ▾] [置顶摘要] [底部面板] [右侧栏]
```

### 3.1 在…中打开

点击后：

```text
[在…中打开 ▾]
└─ VS Code
└─ Visual Studio
└─ Cursor
└─ 文件资源管理器 / Finder / Files
└─ Terminal
└─ 其他已检测到且支持当前目录的程序
```

规则：

- 只显示真实检测到的程序；
- Windows、macOS、Linux 使用各自平台实现；
- 不把开发者电脑上的绝对路径写入 TypeScript；
- 当前 Session 没有 `workspaceRoot` 时，禁用需要工作区的入口并说明原因；
- 打开动作由 Tauri Host 执行，不经过 LocalHost HTTP 路由绕一圈。

下拉形态（Codex 实测校正）：按钮正下方锚定的单列菜单，每行 `应用图标 + 名称`，无分组无描述；检测不到任何可用程序时菜单项替换为一行说明文本，不显示空列表。

建议 Tauri 边界：

```ts
interface ExternalWorkspaceOpener {
  id: string;
  label: string;
  iconId: string;
}

listExternalWorkspaceOpeners(): Promise<ExternalWorkspaceOpener[]>;
openWorkspaceWith(openerId: string, workspaceRoot: string): Promise<void>;
```

### 3.2 置顶摘要

点击后在按钮下方显示浮层，不占用 Dock：

```text
┌──────────────────── 置顶摘要 ────────────────────┐
│ 环境信息                                  [+]   │
│   变更                       +1,217  -180        │
│   本地工作区  D:\Github\EmaAgent                │
│   Git 分支    main                              │
│   提交或推送 / 拉取请求状态（失败如实显示）      │
│   比较分支    上一轮                            │
│                                                  │
│ 运行活动                                        │
│   子智能体      ● 2 运行中   ○ 15 已完成         │
│   后台进程      ● 1 运行中   ○ 2 已完成          │
│                                                  │
│ 来源                                            │
│   图片、文件、粘贴文本……（即本 Session 附件）    │
│   [查看全部]                                    │
└──────────────────────────────────────────────────┘
```

结构已按 Codex 实测校正：

- 环境信息首行是**变更计数**（绿 +N / 红 -N），其次才是工作区与分支；"提交或推送""比较分支"是动作行，没有 Git 能力的 Session 整个环境信息区不渲染，不留空壳；
- **"本地"是环境选择器下拉**（当前环境打勾 + 其他可用环境入口），V1 只有本地环境时下拉只保留一行说明，不虚构云端入口；
- **分支名是分支选择器下拉**：顶部搜索框、分支行携带"未提交：N 个文件"、底部"创建并检出新分支…"；没有 Git 工作区时该行不渲染；
- 运行活动按真实业务分两行聚合：子智能体使用 AgentRun，后台 Shell 使用
  BackgroundProcess；两者只共享摘要外壳，不共享 ID、状态机或详情 DTO；
- **来源就是当前 Session 的附件**（上传图片/文件、粘贴文本形成的附件），列表截断后由"查看全部"打开 `sources` 标签；不虚构网页引用等其他来源；
- 分区标题右侧的 `[+]` 是该分区的快捷动作（如添加来源），没有真实动作的分区不渲染 `[+]`。

点击效果：

```text
点击 Git 改动
└─ 打开或激活 resourceKey = "review"

点击某个子 Agent
└─ 打开或激活 resourceKey = "agentRun:<agentRunId>"

点击“后台进程”
└─ 打开或激活 resourceKey = "backgroundProcesses"

点击“查看全部来源”
└─ 打开或激活 resourceKey = "sources"
```

Task 不放进置顶摘要。Task 是用户/根 Agent 可见的工作项，固定显示在输入框上方。

### 3.3 底部面板

点击效果：

```text
BottomDock 已关闭
├─ 有可恢复标签：恢复上次标签与激活项
└─ 从未使用过：真实 Terminal 能力存在时打开默认终端，否则显示启动器

BottomDock 已打开
└─ 折叠 Dock，但不销毁仍在运行的 Terminal/Browser 实例
```

关闭 BottomDock 的最后一个标签：

```text
关闭最后一个标签
└─ BottomDock 自动折叠
```

显式关闭的标签不会在下一次重启时复活；只是折叠 Dock 则可以恢复。

### 3.4 右侧栏

控制 RightDock 显示和隐藏。首次打开且没有标签时显示工作区启动器：

```text
┌──────────── 工作区启动器 ────────────┐
│ 审阅                                │
│ 终端                                │
│ 浏览器                              │
│ 文件                                │
└──────────────────────────────────────┘
```

只显示当前版本拥有真实能力的入口。不存在真实 PTY、浏览器或 Review 数据源时，不渲染对应入口，不创建空面板。

启动器形态（Codex 实测校正）：Dock 空白时启动器是**内容区居中的浮出菜单**而不是贴边列表；每行 `图标 + 名称`；点击或 Esc 关闭。快捷键方案未定，启动器与 Dock 均不写快捷键。

### 3.5 全宽展开模式

RightDock 展开且内部有内容时，Dock 标题区出现**放大按钮**（仅此时渲染，Dock 折叠或为空时不出现）。点击后 RightDock 占据整个 WorkspaceFrame 宽度，聊天主区隐藏：

```text
普通展开                       全宽展开
┌──────────────┬────────┐      ┌──────────────────────┐
│ ChatHistory  │  Dock  │  →   │ Dock（全宽）          │
│              │        │      │              [恢复宽度]│
├──────────────┴────────┤      ├──────────────────────┤
│ ChatInput             │      │ ⌄ ChatInput 浮动条    │
└───────────────────────┘      └──────────────────────┘
```

规则（Codex 实测校正）：

- 全宽时顶栏的摘要/底部/右侧入口被**恢复面板宽度**按钮替换，聊天列不保留残余宽度；
- ChatInput 在全宽模式下收缩为底部居中的浮动条，可展开为悬浮聊天卡继续对话、可合回输入条；展开/合上是当次状态，不写布局记忆；
- **全宽状态不持久**：折叠 Dock 时丢弃全宽标记，下次打开回到普通宽度，需要重新放大；布局记忆只保存 Dock 显隐与标签，不保存全宽；
- 从全宽直接折叠 Dock 等价于普通折叠，不额外弹确认。

## 4. 工作标签与双 Dock

### 4.1 标签不是固定面板

同一套标签可以位于 RightDock 或 BottomDock：

```text
RightDock:  [审阅 ×] [package.json ×] [+]
BottomDock: [Terminal 1 ×] [浏览器 ×] [+]
```

同一资源只能出现一次：

```text
右侧已有 "review"
用户选择在底部打开审阅
└─ 从 RightDock 移除
└─ 插入 BottomDock
└─ 保持同一个标签实例和内部状态
```

### 4.2 稳定资源键

```text
review
files
file:<normalized-path-key>
terminal:<terminalId>
browser:<browserId>
agentRuns
agentRun:<agentRunId>
sources
```

文件可以打开多个，因为不同路径是不同资源。Terminal 和 Browser 可以打开多个，因为不同运行实例拥有不同 ID。`agentRuns` 是全 Session 子智能体列表面板（2026-07-30 参照 Codex 子智能体标签补充），`agentRun:<id>` 是单次执行的深链标签。

### 4.3 显式标签类型

禁止使用 `meta` 或 `Record<string, unknown>` 猜标签内容：

```ts
type WorkspaceTab =
  | { id: 'review'; kind: 'review' }
  | { id: 'files'; kind: 'files' }
  | { id: `file:${string}`; kind: 'file'; path: string }
  | { id: `terminal:${string}`; kind: 'terminal'; terminalId: string }
  | { id: `browser:${string}`; kind: 'browser'; browserId: string }
  | { id: `agentRun:${string}`; kind: 'agentRun'; agentRunId: string }
  | { id: 'sources'; kind: 'sources' };

interface WorkspaceLayoutState {
  tabsById: Record<string, WorkspaceTab>;
  rightTabOrder: string[];
  bottomTabOrder: string[];
  activeRightTabId?: string;
  activeBottomTabId?: string;
  rightOpen: boolean;
  bottomOpen: boolean;
  rightWidth: number;
  bottomHeight: number;
}
```

`Record + 有序数组` 更适合 JSON 持久化。运行时可以建立派生 Map，但不能把不可序列化 Map 直接当作持久格式。

### 4.4 布局记忆

- 每个 Session 保存标签、顺序、激活项和停靠位置；
- RightDock 宽度和 BottomDock 高度是全局桌面偏好；
- 全宽展开（§3.5）与 ChatInput 浮动条开合是当次运行状态，不进入持久化布局；
- 可恢复的文件标签在重启后重新验证路径；
- 文件失效时显示“文件已移动或无法访问”，不能偷偷替换为其他文件；
- Terminal/Browser 只有运行时支持恢复协议时才恢复；否则恢复为明确的已结束状态；
- UI 布局状态保存在前端本地持久层，不写进 Session 业务数据库。

## 5. 输入框上方：Task、改动与决策

默认紧凑状态：

```text
┌────────────────────────────────────────────────────────┐
│ [任务 2/5 · 执行中]        │        [改动 +38 -226]  │
└────────────────────────────────────────────────────────┘
```

中间只表示布局中心轴，不绘制分隔线。只有任意一个入口时，该入口平滑移动到整体中心；
两个入口同时存在时分别回到左右半区。出现、消失、展开和收起均复用前端动画变量并支持双向过渡。

点击 Task：

```text
点击 [任务 2/5]
└─ 在输入框上方原位展开 TaskList
   ├─ 待处理
   ├─ 进行中
   ├─ 被依赖阻塞
   └─ 已完成（默认折叠）
```

点击改动：

```text
点击 [改动 +38 -226]
└─ 打开或激活 "review" 标签
└─ 默认定位到当前 Turn 的变更过滤
```

Permission/AskUser 是阻塞当前 Turn 的决策，优先级高于 Task 展开内容：

```text
Task/改动摘要
↓
Permission 或 AskUser 卡片
↓
ChatInput
```

当卡片出现时不使用屏幕中央 Modal，不影响用户切换到其他 Session。

## 6. Task 与 AgentRun 必须分开

### TaskList

- 数据源：`GET /api/tasks?sessionId=...`；
- 更新源：`task_created/task_updated/task_deleted`；
- 表示跨 Turn 持久工作项；
- 显示短编号、subject、状态、依赖、activeForm 和可选活动 AgentRun；
- 根 Agent 或用户明确操作才改变 Task 状态。

### AgentRunPanel

- 数据源：`GET /api/agent-runs?sessionId=...`；
- 表示一次子 Agent 执行；
- 显示模型、轮次、工具调用、耗时、文本和终态；
- AgentRun 完成不自动完成 Task；
- 旧 `TaskPanel`、`agent-task-store` 和 `/api/agent-tasks` 是迁移债，应在本批改为 AgentRun 命名。

面板形态（Codex 实测校正）：

- Dock 内的子智能体标签是**列表页**："已开启"区（空时如实显示"没有已开启的子代理"，不隐藏分区）+"完成 · N"区；每行 `图标 + 标题 + 一行摘要 + 相对时间`，列表截断显示"再显示 N 个"；
- 点击行进入**详情页**：顶部返回 + 标题，正文是该次执行的 transcript；底部"已编辑 N 个文件 +A -B"汇总卡，列出文件与增删行，动作按钮接真实能力（审核 → 打开或激活 `review` 标签并过滤到该 AgentRun 的变更；撤销必须接真实回滚能力，没有就不渲染）；
- 详情页是标签内导航，不新开标签。

```text
Task #3：整理存储层
└─ AgentRun A（失败）
└─ AgentRun B（完成）

Task 状态仍由根 Agent 验收后显式更新。
```

## 7. 来源

V1 “来源”至少包括当前已经持久化的附件：

```text
来源
├─ 上传图片
├─ 上传文件
├─ 粘贴文本形成的附件/引用
└─ 后续真实存在的其他输入来源
```

首批复用现有：

- `/api/sessions/:id/attachments`；
- `SessionAttachmentsPanel`；
- Tauri 授权文件句柄。

重命名为 Sources 时不能假装已经保存不存在的网页引用或跨 Session 来源；新增来源种类必须先有真实数据所有者和持久化契约。

## 7.1 后台进程

后台进程不是 Task 或 AgentRun。后端状态与输出契约冻结在
`EmaRefactor.md` §6.1；前端只在真实 API 与事件接通后渲染。

置顶摘要只显示当前 Session 的运行中/完成计数。点击后打开一个
`backgroundProcesses` 动态标签，标签内部是列表到详情的导航：

```text
后台进程列表
├─ ● npm run build       运行中  01:24
├─ ◌ pnpm typecheck      排队中
└─ ✓ cargo test          已完成  exit 0

点击一行
└─ 后台进程详情
   ├─ 命令、工作目录、来源 Turn/Tool Call
   ├─ 状态、时长、退出码
   ├─ stdout/stderr 有界增量
   ├─ [加载更早输出] [跟随尾部]
   └─ [终止]（仅 queued/running）
```

详情输出必须使用后端游标分页，不能一次载入完整日志。终止操作提交
`backgroundProcessId`，不能提交 PID。点击来源跳转到原 Tool Call；Session
删除后该标签进入资源失效状态并关闭，不打开其他 Session 的同名进程。

来源面板形态（Codex 实测校正）：

- 列表每行 `类型图标 + 文件名 + 完整路径 + 状态行`（如"已附加到对话"）；粘贴文本形成的附件与上传文件同级展示，类型图标区分；
- 行点击动作复用现有附件打开能力（授权文件句柄），不新增预览通道；
- 没有"刷新/重新读取"入口：附件是追加事实，不是活引用。

## 8. Turn 快速导航轨

### 8.1 位置

TurnRail 位于聊天消息可视区左侧，不属于 SessionSidebar，也不是第五个 Dock：

```text
┌──────────────── ChatHistory ────────────────┐
│ TurnRail │                                  │
│    ─     │ Turn #81                         │
│    ─     │ 用户消息                         │
│    ───   │ Assistant 回复                   │
│    ━━━   │                                  │
│    ───   │ Turn #82                         │
│    ─     │ ……                               │
└─────────────────────────────────────────────┘
```

### 8.2 可视窗口

不能把上千个 Turn 压缩到同一高度。导航轨根据可用高度计算当前能显示的刻度数量，只渲染一段索引窗口。

```text
全部 Turn： 1 ................................................ 1200
当前索引窗：                         [681 ............ 748]
当前正文：                                      Turn 723
```

鼠标滚轮在 TurnRail 上滚动时：

```text
wheel up
└─ 索引窗口向更早 Turn 平移
└─ 不滚动聊天正文

wheel down
└─ 索引窗口向更新 Turn 平移
└─ 不滚动聊天正文
```

触控板连续 delta 需要累计阈值，避免一次轻扫跳过几十个 Turn。

### 8.3 悬停动态

悬停项使用明显主题色，邻近刻度按距离逐级变长：

```text
普通             ─
距离 3           ──
距离 2           ────
距离 1           ───────
悬停             ━━━━━━━━━━━
距离 1           ───────
距离 2           ────
距离 3           ──
普通             ─
```

动态规则：

- 颜色、长度和透明度都通过 CSS Token；
- 邻近变化使用 transform/opacity，不触发布局抖动；
- 展开与恢复使用现有 motion duration/easing；
- `prefers-reduced-motion` 下取消连续缩放，只保留颜色和长度的即时差异。

悬停卡片：

```text
┌──────────────────────────────────┐
│ 14:16 · Work · 已完成            │
│ 铅笔只用于最后一轮重写，历史位置 │
│ 使用 Fork 创建独立 Session……     │
└──────────────────────────────────┘
```

只展示服务端生成的有界摘要，不把 thinking、完整 Tool Result 或附件正文塞进索引。

### 8.4 当前 Turn 与点击

```text
MessageViewport 滚动
└─ IntersectionObserver 找到最接近顶部的 Turn
└─ TurnRail 高亮该 Turn
└─ 必要时平移索引窗口，使其重新进入可视区

点击已加载 Turn
└─ 平滑滚动到 data-turn-id="<turnId>"

点击未加载 Turn
└─ 请求该 Turn 附近的消息窗口
└─ 切换到 archive 模式
└─ DOM 完成后定位目标 Turn
```

## 9. 热尾正文、冷索引与按需历史

### 9.1 三层数据

```text
Hot Tail
└─ 最近 100 条完整消息，支持当前 SSE 与输入

Cold Turn Index
└─ 轻量 Turn 摘要，按游标分页，仅供定位和预览

Archive Message Window
└─ 点击旧 Turn 后，加载目标前后少量 Turn 的完整消息
```

浏览旧历史时，新 SSE 继续更新 Hot Tail，不覆盖用户当前阅读位置。UI 显示：

```text
[有 1 条新回复 · 回到最新]
```

### 9.2 不拼接不连续数组

不能把很早的窗口直接插入最近消息数组并假装中间连续。前端状态明确分成：

```ts
interface SessionHistoryState {
  mode: 'tail' | 'archive';
  tail: ChatHistoryItem[];
  archiveWindow?: ArchiveMessageWindow;
  turnIndex: TurnIndexState;
  unseenTailCount: number;
}
```

每个 Session 可以保留最近访问的 3 个 Archive Window，使用 LRU 回收。大型附件正文不进入该缓存。

## 10. 后端接口

### 10.1 继续复用

| 接口 | 用途 |
|---|---|
| `GET /api/sessions/:id/messages?limit=100` | 最近完整消息 |
| `GET /api/tasks?sessionId=...` | Task 重启快照 |
| `GET /api/agent-runs?sessionId=...` | AgentRun 列表 |
| `GET /api/agent-runs/:id/messages` | 子 Agent transcript |
| `GET /api/background-processes?sessionId=...` | 当前 Session 后台进程列表 |
| `GET /api/background-processes/:id/output?cursor=...` | stdout/stderr 有界增量 |
| `POST /api/background-processes/:id/stop` | 取消排队项或终止进程树 |
| `GET /api/sessions/:id/attachments` | 来源中的附件 |
| Workspace 文件读取接口 | Files 与 File 标签 |

### 10.2 新增 Turn 索引

```http
GET /api/sessions/:sessionId/turn-index?cursor=...&limit=200
```

```ts
interface TurnIndexItemWire {
  turnId: string;
  startedAt: number;
  completedAt: number | null;
  status: TurnStatus;
  triggerType: TurnTriggerType;
  executionProfile: ExecutionProfile;
  preview: string;
}

interface TurnIndexPageWire {
  items: TurnIndexItemWire[];
  nextCursor?: string;
}
```

要求：

- 游标使用 `(started_at, id)`，不能只用时间；
- `preview` 优先从 `turns.user_input` 生成并限制字符数；
- 将来非用户触发 Turn 使用明确 trigger 文案；
- 查询只读必要列，不反序列化 MessageBlocks；
- 先检查现有索引并运行 `EXPLAIN QUERY PLAN`，没有证据不新增迁移。

### 10.3 新增目标消息窗口

```http
GET /api/sessions/:sessionId/messages/window
  ?anchorTurnId=...
  &beforeTurns=8
  &afterTurns=12
```

返回：

```ts
interface SessionMessageWindowWire {
  anchorTurnId: string;
  turns: TurnWire[];
  messages: MessageWire[];
  hasOlder: boolean;
  hasNewer: boolean;
}
```

约束：

- anchorTurnId 必须属于当前 Session；
- before/after 有服务端硬上限；
- 返回顺序稳定；
- 用户附件继续签发受限文件句柄；
- 不读取附件正文；
- 不影响当前运行 Turn 或 SSE。

## 11. 前端目录

目录表示最终职责，不会一次创建空文件。按批次只创建当批真实组件。

```text
apps/desktop-ui/src/chat/
├─ ChatPanel.tsx                    总体装配，不继续承载标签状态机
├─ ChatHeader.tsx                   标题与四个顶栏入口
│
├─ history/
│  ├─ ChatHistory.tsx              消息窗口
│  ├─ TurnRail.tsx                 Turn 导航轨
│  ├─ turnRailModel.ts             可视索引与邻近长度计算
│  └─ sessionHistoryStore.ts       热尾/冷索引/历史窗口
│
├─ workspace/
│  ├─ WorkspaceFrame.tsx           MainRow + BottomDock
│  ├─ WorkspaceDock.tsx            Right/Bottom 共用 Dock
│  ├─ WorkspaceTabBar.tsx          标签、关闭、排序、移动
│  ├─ WorkspaceLauncher.tsx        “+”菜单
│  ├─ workspaceStore.ts            每 Session 布局与持久化
│  └─ workspaceTypes.ts            可判别标签类型
│
├─ tasks/
│  ├─ TaskStrip.tsx                输入框上方紧凑摘要
│  └─ TaskList.tsx                 真正的持久 Task
│
├─ agentRuns/
│  ├─ AgentRunSummary.tsx          置顶摘要中的概况
│  └─ AgentRunPanel.tsx            一次子 Agent 执行详情
│
├─ backgroundProcesses/
│  ├─ BackgroundProcessSummary.tsx 置顶摘要中的后台进程概况
│  ├─ BackgroundProcessPanel.tsx   列表与详情导航
│  └─ backgroundProcessStore.ts    快照、事件与输出游标
│
├─ sources/
│  ├─ SourcesSummary.tsx           置顶摘要中的来源概况
│  └─ SourcesPanel.tsx             完整来源标签
│
└─ summary/
   └─ PinnedSessionSummary.tsx     工作区/Git、运行活动、来源
```

如果某目录最终只有一个简单组件，则直接放回 `chat/`，不为了目录图制造几行小文件。

## 12. 样式与动效

- 颜色、圆角、阴影、持续时间、缓动从现有 `styles` 与 UI 组件取；
- TurnRail 新增的通用动画放入 `styles/animations.css` 或相应现有文件；
- RightDock/BottomDock 展开和折叠使用现有宽高过渡；
- 拖拽期间禁用过渡，释放后恢复；
- 不在业务组件里新增一组平行 CSS Variable；
- Tailwind 使用项目当前语法，不机械引入过时的任意值写法；
- 小屏或窗口过窄时优先折叠 RightDock，不能把 ChatInput 压到不可用。

## 13. 能力依赖与不能伪造的 UI

| UI | 当前事实 | 实施要求 |
|---|---|---|
| Files/File | 已有浏览与文件预览接口 | 可首批迁入 Dock |
| Sources | 已有 Session 附件接口 | 可首批实现附件来源 |
| TaskList | 后端 Task 快照与事件已完成 | 必须新增独立 UI |
| AgentRun | 原生 API、Store 与独立 Panel 已完成 | 后续迁入 Workspace Dock |
| BackgroundProcess | 后端 RFC 已冻结，运行时/API 尚未实现 | 不画假运行项；后端完成后接活动摘要与动态标签 |
| TurnRail | 最近消息与部分 Turn 已有 | 增加冷索引和窗口接口 |
| Review | 尚需确定真实变更聚合来源 | 不先画空面板 |
| Terminal | 后台进程不等于交互式 PTY | 先建立真实 Terminal Runtime |
| Browser | WebFetch 不等于可交互浏览器 | 先建立真实 Browser Runtime |
| 在…中打开 | Tauri 只有受限文件打开能力 | 增加跨平台程序检测与打开命令 |

## 14. 分批实施

### 批次 A：Task 与 AgentRun 前端语义收口

状态：已完成。Task 与 AgentRun 已拥有独立 API、Store 和 UI；旧 `/api/agent-tasks`、`agent-task-store` 与 `TaskPanel` 已删除。

范围：

- 新建 Task API/store/TaskStrip/TaskList；
- 消费 Task 快照与结构化事件；
- `TaskPanel` 改成 `AgentRunPanel`；
- 前端从 `/api/agent-tasks` 迁到 `/api/agent-runs`；
- 删除旧字段名和兼容 API。

不碰：Dock、TurnRuntime、Terminal、Browser。

### 批次 B：TurnRail 与历史窗口

状态：已完成。

范围：

- 后端 TurnIndex 与 MessageWindow；
- 前端 sessionHistoryStore；
- TurnRail、悬停动态、滚轮索引窗口；
- archive/tail 切换和“回到最新”。

TurnRail 的最外层是透明轨道容器，只承担定位、滚轮与指针命中；刻度按钮同样无底色。
可见反馈只来自刻度长度、语义色与邻域过渡，Turn 预览使用独立半透明 Tooltip。

不碰：Task 语义和 Dock。

### 批次 C：工作区框架

范围：

- WorkspaceFrame、RightDock、BottomDock；
- Tab 唯一性、移动、关闭、布局记忆；
- 迁入已有 Files/File、Sources、AgentRun；
- 替换 ChatPanel 的旧 Inspector Set/Grid。

不注册尚无能力的 Terminal/Browser/Review。

### 批次 D：顶栏与桌面能力

范围：

- 四个顶栏按钮；
- 置顶摘要；
- Tauri 跨平台 opener 检测；
- Git/工作区摘要的真实只读来源。

### 批次 E：真实 Review、Terminal、Browser

每项独立评审和实现：

- Review：明确 Git diff 与 Tool 实际改动的事实来源；
- Terminal：PTY、大小调整、输入输出、取消、重启终态；
- Browser：浏览器实例、导航、权限、下载和网络安全。

不能把三项合成一个“Panel UI 批次”。

### 批次 F：后台进程活动面板

后端 `BackgroundProcess + ProcessOutput/ProcessStop`、列表 API 和 Session
事件完成后，由前端模型按 §3.2 与 §7.1 实现：

- 置顶摘要中的后台进程计数；
- `backgroundProcesses` 动态标签；
- 列表、详情、游标输出与终止；
- AgentRun 与 BackgroundProcess 并列展示但保持独立 Store/DTO。

本批不实现交互式 PTY Terminal，也不把后台日志面板伪装成 Terminal。

Review 交互细节（Codex 实测校正，实施时按此验收）：

- **比较范围选择器**：面板头部 `上一轮 ⌄` 下拉，选项为"上一轮（当前 Turn 的工具变更）/ 未暂存 / 已暂存 / 提交记录 / 分支比较"中有真实数据来源的项；没有来源的项不渲染。默认定位到当前 Turn；
- **按文件分块**：每块头部 `图标 + 文件路径 + 增删计数 + 折叠钮`，块可展开/折叠；
- **折叠优先的增量展开**：默认只展开变更 hunk 及其紧邻上下文，其余未变更区一律折叠为 "N unmodified lines" 段；点击折叠段每次只展开一小段（固定行数，如 ±20 行），不做整文件加载，也不做按需计算的智能上下文（V1 技术范围外，明确不实现）；
- **跳转到文件**：面板内搜索/跳转入口定位到该文件的 diff 块（不离开审阅标签）；
- **在标签页中打开文件**：文件块头部动作把该文件以 `file:<path>` 标签打开（复用 §4.2 资源键，同一文件已开则激活）；
- 视图切换：统一差异 / 分列差异，切换不丢失展开状态；
- 文件清单视图：全部变更文件的紧凑列表（路径 + 增删计数），与 diff 视图并列切换；
- 选项菜单只放真实能力（刷新、自动换行、隐藏空白字符等）；没有真实后端支撑的项目（如"复制 git apply 命令"）不照抄；
- "提交或推送""创建拉取请求"等 Git 写操作不属于 Review 面板职责，Ema 的 Review 只做只读审阅 + 跳转，不接 Git 写入口。

## 15. 多模型协作建议

在后端 Wire 与状态机冻结前，不建议把整个前端交给另一个模型一次性改完。可拆为：

```text
主架构负责人
├─ 冻结 Task/AgentRun/TurnIndex/MessageWindow 契约
├─ 实现 sessionHistoryStore 与 workspaceStore 状态机
└─ 审查 ChatPanel 装配和跨 Session 行为

前端模型（GLM/Kimi）
├─ TurnRail 视觉与动效
├─ WorkspaceTabBar / Launcher / Dock 布局
├─ TaskList 与 AgentRun 卡片展示
├─ 置顶摘要视觉实现
└─ 后端完成后实现 BackgroundProcess 活动面板
```

委派时必须明确文件所有权，避免同时修改：

- `ChatPanel.tsx`；
- `conversation-store.ts`；
- `conversation-sse.ts`；
- `apps/localHost/src/routes/sessions.ts`；
- `EmaWorkState.md`。

适合并行的前提：

1. 后端 DTO 已冻结；
2. 状态 Store 接口已冻结；
3. 视觉模型只消费 mock/真实接口，不自行发明字段；
4. 最后由同一负责人审查跨 Session、断线、历史窗口和能力门禁。

## 16. 验收标准

### 历史与 TurnRail

- 最近消息首次打开快速显示；
- 上千 Turn 不会一次加载上千条正文；
- 滚轮浏览索引不推动消息区；
- 点击冷 Turn 只加载有限窗口；
- 当前 SSE 在浏览旧历史时继续运行；
- 回到最新不重新请求已缓存热尾；
- 多 Session 的索引窗口、草稿和阅读位置互不覆盖。

### Task 与 AgentRun

- Task 与 AgentRun 不再共用“后台任务”卡片；
- 重启后 Task 从 `/api/tasks` 恢复；
- AgentRun transcript 使用 AgentRun ID；
- AgentRun 完成不自动完成 Task；
- Chat 和 Work 都可查看 Task，只有 Work 向模型提供 Task Tools。

### Dock

- 同一标签不能同时位于右侧和底部；
- 移动标签不丢内部状态；
- 关闭最后标签自动折叠；
- 每个 Session 恢复自己的标签；
- 已失效文件显示错误状态；
- 不存在的能力不显示入口；
- 放大按钮只在 Dock 展开且有内容时出现；全宽与普通宽度可互相恢复；
- 折叠 Dock 丢弃全宽状态，重新打开回到普通宽度；全宽时 ChatInput 浮动条可展开/合上且不写布局记忆。

### 安全与平台

- 外部程序由 Tauri 按平台检测；
- 不硬编码本机开发路径；
- 文件预览继续受授权路径约束；
- UI 不从 Tool 文本猜权限、Diff 或运行终态；
- Windows、macOS、Linux 均有明确降级行为。

## 17. 开工前决策

开始代码前只需决定执行顺序，不需要重新讨论布局：

1. 先完成批次 A/B 的数据契约和状态模型，再把批次 C/D 的视觉组件交给前端模型；
2. 或先继续统一 TurnRuntime/TurnLoop，等后端主架构稳定后再集中做全部前端。

无论选择哪种，不能让前端模型同时修改 LocalHost Turn 编排。推荐先完成 **批次 A（Task/AgentRun）和批次 B 的后端契约**，随后前后端按文件边界并行；TurnRuntime 大重构继续由理解完整执行链的负责人处理。
