# EmaAgent 前端骨架蓝图

**用途**：完整列出 V1 前端要新建的所有文件、每个文件的职责、对外暴露的主要接口。
不写实现细节，只定边界。任何 AI / 开发者拿到这份文档应该能直接开干，不需要再问"这文件做什么"。

---

## 0. 全局规范（所有文件必须遵守）

| 项 | 规范 |
|---|---|
| 框架 | React 18 + TypeScript 严格模式 |
| CSS | UnoCSS（无 inline `style={{}}`、无 `<style>` 块、无 `.css` import 业务样式）|
| 状态管理 | Zustand（跨组件状态强制走 store，不准 props drilling 超过 2 层） |
| 状态管理 immer | 用 `zustand/middleware` 的 `immer` |
| 组件库基础 | Radix UI primitives（Dialog / Popover / Tooltip / Select / DropdownMenu / Tabs / Switch / Slider / Toast） |
| 动画 | `@formkit/auto-animate/react` 处理增删动画，复杂动画用 motion-one |
| 圆角 | **所有视觉矩形圆角 ≥ 8px**，按钮/卡片/popover/textarea/dialog 一律不用直角 |
| 设计 token | 主色：粉白 `#ffd6e6`（Ema 头发主色）；辅色：粉紫 `#e0c4ff`；语义：success `#22c55e` / warn `#f59e0b` / danger `#ef4444` |
| 字体 | "Microsoft YaHei", "PingFang SC", system-ui, sans-serif |
| 包之间禁止 | desktop-ui 不准 import apps/desktop；ui 不准 import desktop-ui；live2d-react 不准 import ui 或 desktop-ui |
| import 扩展名 | NodeNext 风格 `.js` 后缀（跟仓库已有规范一致）|
| 文件名 | kebab-case；组件文件 PascalCase |
| 测试 | Vitest + React Testing Library，store 用 contract test 风格 |

---

## 1. `packages/ui/` — L1 原子组件层

**职责**：纯 UI 组件。不知道业务、不知道 sidecar、不知道 Live2D。只接 props，渲染像素。
**对外只通过 `src/index.ts` 导出**。

### 1.1 配置文件

| 文件 | 职责 |
|---|---|
| `package.json` | name=`@ema-agent/ui`；deps: react@18、@radix-ui/* primitives、unocss、clsx、tailwind-merge、@formkit/auto-animate；devDeps: @ladle/react、typescript |
| `tsconfig.json` | extends `../../tsconfig.base.json` |
| `uno.config.ts` | **导出** `sharedUnoPreset()` 共享给 desktop-ui 和 apps/desktop 复用。包含 preset-wind3 + preset-attributify + preset-icons + 自定义 safelist（粉白色阶 50-950）+ 圆角 token |
| `ladle.config.mjs` | Ladle 配置；stories glob = `src/**/*.stories.tsx` |

### 1.2 工具

| 文件 | 主要导出 |
|---|---|
| `src/utils/cn.ts` | `cn(...args: ClassValue[]): string` —— clsx + tailwind-merge 合并 |
| `src/utils/index.ts` | barrel |

### 1.3 组件清单

每个文件一个组件，stories 同目录平级（`*.stories.tsx`）。

| 文件 | 用途 | 主要 props（类型签名） |
|---|---|---|
| `Button.tsx` | 标准按钮 | `{ variant?: 'primary'\|'secondary'\|'ghost'\|'danger', size?: 'sm'\|'md'\|'lg', shape?: 'rounded'\|'pill', loading?: boolean, disabled?: boolean, block?: boolean, icon?: string, onClick }` |
| `IconButton.tsx` | **圆形**图标按钮（用于 dock、send、工具栏） | `{ icon: string\|ReactNode, label: string (aria), size?: 'sm'\|'md'\|'lg', variant?: 'default'\|'primary'\|'danger', toggled?: boolean, onClick }` —— 强制 `rounded-full` |
| `Input.tsx` | 单行文本输入 | `{ value, onChange, placeholder?, type?, disabled?, error? }` |
| `Textarea.tsx` | 多行自适应高度输入；**支持右下角内嵌 slot**（用于 ChatInput 的 send 按钮） | `{ value, onChange, placeholder?, autoGrow?, maxRows?, embeddedAction?: ReactNode, onKeyDown? }` ——`embeddedAction` 是 absolute-positioned bottom-right slot |
| `Card.tsx` | 圆角容器 + 半透明背景 + 内描边 | `{ variant?: 'default'\|'elevated', padding?: 'sm'\|'md'\|'lg' }` |
| `Dialog.tsx` | Radix Dialog wrap | `{ open, onOpenChange, title, children }` |
| `Popover.tsx` | Radix Popover wrap | `{ trigger: ReactNode, side?, align?, children }` |
| `Tooltip.tsx` | Radix Tooltip wrap | `{ content: string, children, side? }` |
| `DropdownMenu.tsx` | Radix DropdownMenu wrap | `{ trigger, items: MenuItem[], children? }` —— 支持 nested submenu |
| `Select.tsx` | Radix Select wrap | `{ value, onChange, options: {value,label,icon?}[], placeholder? }` |
| `Tabs.tsx` | Radix Tabs wrap | `{ value, onChange, items: {value,label,icon?}[], orientation?: 'horizontal'\|'vertical' }` |
| `Switch.tsx` | toggle | `{ checked, onChange, disabled?, label? }` |
| `Slider.tsx` | Radix Slider wrap（用于 Effort 之类的离散档位） | `{ value, onChange, steps: {value:number,label:string}[] }` |
| `Skeleton.tsx` | loading placeholder | `{ width?, height?, animation?: 'pulse'\|'wave'\|'none' }` |
| `Callout.tsx` | 提示框 | `{ variant: 'info'\|'success'\|'warn'\|'danger', title?, children }` |
| `Spinner.tsx` | 圆形 spinner | `{ size?: 'sm'\|'md'\|'lg' }` |
| `Badge.tsx` | 标签徽章（mode 标识、状态点） | `{ variant?, dot?: boolean, children }` |
| `Divider.tsx` | 分隔线（水平/垂直） | `{ orientation? }` |
| `ScrollArea.tsx` | Radix ScrollArea wrap（自定义滚动条） | `{ children, orientation? }` |

### 1.4 导出

`src/index.ts`：barrel 所有组件 + utils + uno preset。
package.json `exports` 字段提供精细化 subpath：
- `.` → index
- `./components/*` → 单组件直接 import（tree-shaking 友好）
- `./utils` → cn 等
- `./uno` → uno.config 共享 preset

---

## 2. `packages/live2d-react/` — L2 Live2D 渲染层

**职责**：把 PixiJS + Live2D 包装成 React 组件。不知道业务、不知道角色卡数据形态——只接受"模型路径"和"motion / expression 指令"。
**对外只通过 `src/index.ts` 导出**。

### 2.1 配置文件

| 文件 | 职责 |
|---|---|
| `package.json` | name=`@ema-agent/live2d-react`；deps: react@18、pixi.js@7、pixi-live2d-display@0.5-beta、zustand、animejs |
| `tsconfig.json` | extends base |

### 2.2 组件

| 文件 | 职责 | 主要 props |
|---|---|---|
| `src/components/Live2DStage.tsx` | 顶层场景容器。响应式尺寸（ResizeObserver）。通过 render-prop 把 `{width,height}` 传给 Canvas | `{ modelPath: string, onReady?, onError?, framing?: 'fullbody'\|'halfbody', children? }` |
| `src/components/Live2DCanvas.tsx` | 创建 PIXI Application。设置 backgroundAlpha=0。**安装渲染守卫**（try/catch 包 ticker）。导出 `app` 实例给子节点 | `{ width, height, maxFps?, resolution?, onApp: (app: Application) => void }` |
| `src/components/Live2DModel.tsx` | 加载模型 + 注册 MotionManager 插件 + 监听 expression / motion store | `{ app: Application, modelPath: string, framing?, onLoad? }` —— 不接受直接的 expression/motion，靠 store |

### 2.3 Composables（hooks）

| 文件 | 主要导出 |
|---|---|
| `src/composables/useMotionManager.ts` | `useMotionManager(model, options): { register(plugin, stage: 'pre'\|'post'\|'final'): () => void }` —— hook 原始 update 方法实现插件管线 |
| `src/composables/useExpressionController.ts` | `useExpressionController(model): { setExpression(name), available: string[] }` —— 加载 model3.json 里的 expressions |
| `src/composables/useIdleMotion.ts` | 默认空闲动作循环 |
| `src/composables/useFocusTracking.ts` | 眼睛 / 头 跟随鼠标位置（V1.5） |
| `src/composables/usePixelTransparency.ts` | 鼠标在 canvas 哪里、像素是否透明（用于自动 passthrough）；V1.5 实现 |

### 2.4 Stores（Zustand）

| 文件 | 主要 state | 主要 actions |
|---|---|---|
| `src/stores/live2d-store.ts` | `{ currentExpression: string\|null, currentMotion: { group, index }\|null, scale, anchorY, focus: {x,y}\|null }` | `setExpression`, `playMotion`, `setScale`, `setAnchor`, `setFocus` |

### 2.5 类型 & 工具

| 文件 | 内容 |
|---|---|
| `src/types.ts` | `Live2DStageHandle`、`MotionPlugin`、`ExpressionRef` |
| `src/utils/cubism-core.d.ts` | `declare global { interface Window { Live2DCubismCore: ... } }` |

### 2.6 导出

`src/index.ts`：`Live2DStage` / `useLive2DStore` / 类型。
**不导出**内部 Composables（除非 desktop-ui 真的需要——目前不需要）。

---

## 3. `packages/desktop-ui/` — L3 业务组件 + Stores + API

**职责**：连接 ui 包 + live2d-react + sidecar API 的业务层。包含所有跟 EmaAgent 业务相关的组件、状态、API 调用。
**对外只通过 `src/index.ts` 导出**。

### 3.1 配置文件

| 文件 | 职责 |
|---|---|
| `package.json` | name=`@ema-agent/desktop-ui`；deps: react、@ema-agent/ui、@ema-agent/live2d-react、@ema-agent/contracts、zustand、immer、react-markdown、remark-math、remark-gfm、rehype-raw、rehype-shiki、rehype-katex、rehype-sanitize、shiki、katex、dompurify、dayjs |
| `tsconfig.json` | extends base |

### 3.2 Stores

| 文件 | state | 关键 actions | 备注 |
|---|---|---|---|
| `src/stores/sidecar-store.ts` | `{ port: number\|null, health: 'pending'\|'ok'\|'error', error?: string }` | `setPort`, `setHealth` | 启动时 Tauri 注入 port |
| `src/stores/chat-store.ts` | `{ sessions: Session[], activeSessionId: SessionId\|null, messages: Map<SessionId, Message[]>, streamingMessage: StreamingMessage\|null, sending: boolean }` | `setSessions`, `setActive`, `beginStream`, `appendLiteral(delta)`, `appendToolCall(callId,name,args)`, `appendToolResult(callId,output)`, `finalizeStream`, `appendMessage`, `clearStream` | **三步法**核心；流式三步严格隔离 |
| `src/stores/settings-store.ts` | `{ providers: ProviderConfig[], bindings: ModelBindings, cards: CharacterCard[], activeCardId, modelsPerMode: Record<'chat'\|'narrative'\|'agent', string[]>, effort: 'low'\|'medium'\|'high'\|'max', fastMode: boolean }` | `loadAll()`, `upsertProvider`, `updateBinding`, `setActiveCard`, `setModelsPerMode`, `setEffort`, `setFastMode` | 来自 `/api/providers` + `/api/model-bindings` + `/api/cards` + `/api/settings` |
| `src/stores/live2d-runtime-store.ts` | `{ currentEmotion: string, currentMotion: string }` | `applyEmotion(e)`, `applyMotion(m)` | 由 SSE `emotion_changed` / `stage_cue` 事件驱动；订阅写入 live2d-react 的 store |

**所有 store 必须支持 `subscribe()` 给非 React 代码用**（比如 Tauri events listener）。

### 3.3 Hooks

| 文件 | 主要导出 | 用途 |
|---|---|---|
| `src/hooks/useSse.ts` | `useSse<T>(url: string, handlers: { [eventType]: (data: T) => void }, opts?: { lastEventId? }): { connected: boolean, reconnect() }` | 消费 `/api/turns/:id/events`；自动重连 |
| `src/hooks/useTauriEvents.ts` | `useTauriEvent(name, handler)`、`emitTauriEvent(name, payload)` | Tauri emit/listen 跨窗同步（如新会话创建广播） |
| `src/hooks/useSidecarApi.ts` | `useSidecarApi(): { fetch(path, init?): Promise<Response> }` | 自动用 sidecar-store 的 port 拼 baseUrl |
| `src/hooks/useChatSend.ts` | `useChatSend(): { send(text, options?): Promise<void>, sending: boolean }` | 包装 chat-store + send-queue + POST /api/turns + useSse |

### 3.4 API 客户端

每个文件对应 sidecar 的一组路由，纯函数 `(client, args) => Promise<Result>`。

| 文件 | 端点 |
|---|---|
| `src/api/client.ts` | `createSidecarClient(getPort: () => number\|null): SidecarClient`；提供 `get/post/put/delete/multipart` 方法 + 错误归一化 |
| `src/api/health.ts` | `GET /health` |
| `src/api/turns.ts` | `POST /api/turns`、`GET /api/turns/:id/events`（SSE 走 useSse）、`GET /api/turns/:id/audio` |
| `src/api/sessions.ts` | `GET /api/sessions`、`POST /api/sessions`、`DELETE /api/sessions/:id` |
| `src/api/providers.ts` | `GET/POST/PUT/DELETE /api/providers` |
| `src/api/model-bindings.ts` | `GET/PUT/DELETE /api/model-bindings/:module` |
| `src/api/cards.ts` | `GET/POST/PUT/DELETE /api/cards` |
| `src/api/cards-voice.ts` | `GET/POST/DELETE /api/cards/:id/voice-refs`、`PUT /api/cards/:id/voice-refs/primary` |
| `src/api/settings.ts` | `GET/PUT /api/settings/:key` |
| `src/api/transcribe.ts` | `POST /api/transcribe`（multipart） |
| `src/api/memory.ts` | `GET /api/memory/stats` 等 |

### 3.5 Lib

| 文件 | 主要导出 |
|---|---|
| `src/lib/send-queue.ts` | `createSendQueue(handler: (item) => Promise<void>): { enqueue, on }` —— 串行队列防 race |
| `src/lib/llm-marker-parser.ts` | `createLlmMarkerParser({ onLiteral, onSpecial, onEnd, minLiteralEmitLength? })` —— 解析 `<|ACT:emotion:happy|>` 这种标签，从 AIRI 改 React 版本 |
| `src/lib/format-time.ts` | `formatRelative(ts: number): string` —— "4 小时前" |
| `src/lib/clipboard.ts` | `copyToClipboard(text)` |

### 3.6 Markdown 渲染

| 文件 | 主要导出 |
|---|---|
| `src/markdown/MarkdownRenderer.tsx` | `<MarkdownRenderer content={string} allowHtml?={boolean} />` —— react-markdown + 完整 pipeline |
| `src/markdown/processor-cache.ts` | 按语言缓存 shiki processor（无代码块走 fallback fast path） |
| `src/markdown/code-block.tsx` | `<CodeBlock language={lang} code={string} />` —— 高亮 + 复制按钮 |
| `src/markdown/math.tsx` | `<MathBlock content />` / `<InlineMath content />` —— LaTeX 块级 + 行内（KaTeX 渲染） |

**渲染 pipeline**（顺序）：
```
markdown string
  → remark-parse           (Markdown AST)
  → remark-math            (识别 $...$ / $$...$$)
  → remark-gfm             (GFM 扩展：表格 / 删除线 / 任务列表)
  → remark-rehype          (转 HTML AST，passThrough: ['math', 'inlineMath'])
  → rehype-raw             (允许内嵌原始 HTML 标签，受 allowHtml prop 控制)
  → rehype-katex           (LaTeX → MathML/HTML，output: 'mathml' 性能更好)
  → rehype-shiki           (代码块语法高亮，light + dark 双主题)
  → rehype-sanitize        (白名单清洗 HTML 防 XSS；schema 允许 KaTeX 类名)
  → rehype-stringify       (序列化 HTML)
  → DOMPurify              (最终兜底过滤，配置 ALLOWED_TAGS 含 mjx-* / katex 类)
  → React 通过 dangerouslySetInnerHTML 挂载
```

**安全要点**：
- `allowHtml=true` 默认**只在受信任内容**（assistant 消息）打开
- 用户输入回显 (`role='user'`) 永远 `allowHtml=false`
- KaTeX 输出的 `<span class="katex">` 树 + MathML 标签必须在 sanitize schema 白名单里
- 代码块用 Shiki 的 `output: 'html'`，sanitize 时保留 `<span style="color:...">` inline color（无 onclick/onerror）
- 严禁 `<script>` / `<iframe>` / 事件 attribute 等

### 3.7 业务组件

#### Dock

| 文件 | 职责 | props |
|---|---|---|
| `src/components/dock/FloatingDock.tsx` | 主窗右侧悬浮 dock。6 按钮：chat / settings / expression / pin / passthrough / quit。fade-in/out 由父组件控制 visible | `{ visible: boolean, onAction(id: DockActionId): void }` |
| `src/components/dock/DockButton.tsx` | dock 单按钮。用 ui/IconButton + Tooltip | `{ id, icon, label, active?, danger?, onClick }` |

#### Chat 子窗

每个组件独立文件，组合在 ChatPanel 里。

| 文件 | 职责 |
|---|---|
| `src/components/chat/ChatPanel.tsx` | 整个聊天子窗。组合 Header + Messages + Input + StatusBar |
| `src/components/chat/ChatHeader.tsx` | 顶栏：左边 session 标题 + dropdown 触发器 ▾、右边窗口操作（缩小/最大化/关闭走 Tauri） |
| `src/components/chat/SessionSwitcher.tsx` | popover：搜索框 + session list + "新建会话" 按钮 |
| `src/components/chat/ChatMessages.tsx` | 消息列表区。auto-animate；自动 scroll-to-bottom；streamingMessage 实时插入 |
| `src/components/chat/ChatBubble.tsx` | 单条消息。`{ message: Message, isStreaming?: boolean, onCopy?, onDelete? }`。内部用 MarkdownRenderer；tool_use 块用 ChatToolCallBlock |
| `src/components/chat/ChatToolCallBlock.tsx` | tool_call 块：折叠式展示 name + args + result |
| `src/components/chat/ChatInput.tsx` | **核心**。用 ui/Textarea，**embeddedAction = 圆形 IconButton 放右下角内嵌**。下方是 ChatToolbar | `{ onSend(text), disabled?, mode, onModeChange }` |
| `src/components/chat/ChatToolbar.tsx` | textarea 下方一行：📎附件 / 🎤录音 / 🔊TTS toggle / 💬Chat ▾（mode picker），按钮全用 ui/IconButton；**没有"发送"按钮**（发送在 textarea 内嵌） |
| `src/components/chat/ModePicker.tsx` | mode dropdown：chat / narrative / agent；agent 是嵌套二级（plan/debug/full） |
| `src/components/chat/ChatStatusBar.tsx` | 底部状态栏。左：模型 badge（点开 ModelPicker），中：Context window 触发器（点开 ContextWindowPanel），右：sidecar 状态点 |
| `src/components/chat/ModelPicker.tsx` | popover：当前 mode 的候选模型列表（来自 settings.models[mode].available）+ Effort 单选 + Fast mode toggle |
| `src/components/chat/ContextWindowPanel.tsx` | popover：context window 占比看板（字段见 [chat-ui-patterns memory](chat-ui-patterns)），数据来自 `GET /api/turns/:id/context-breakdown` |

#### Permission / AskUser 弹窗（全局可触发）

由 SSE `permission_required` 事件 或 AskUserQuestion-类 tool event 触发。是**模态**，会盖在 chat 子窗或主窗上。所有这类决策共享同一套 UI 规范——见 [feedback-tool-translation memory](feedback-tool-translation)。

| 文件 | 职责 |
|---|---|
| `src/components/decision/DecisionLayer.tsx` | 顶层渲染器，订阅 `permission_required` / `ask_user_*` 事件，根据 payload type 路由到下面的具体组件。一个时刻只显示一个 prompt |
| `src/components/decision/PermissionPrompt.tsx` | Permission 二选一（[同意] [拒绝]）。**humanDescription 在上 + 大字号、原始命令在下 + 等宽 + 正常显示（不折叠）** |
| `src/components/decision/AskConfirmPrompt.tsx` | 确认型 AskUser（[确认] [取消]） |
| `src/components/decision/AskTextPrompt.tsx` | 文本输入型（label + textarea + [提交]） |
| `src/components/decision/AskChoicePrompt.tsx` | 单选/多选型；末尾可选 "其他（自定义）" 行 |
| `src/components/decision/RawCommandPanel.tsx` | 共享子组件：显示原始 toolName + args（不折叠，等宽字体灰底） |
| `src/components/decision/HumanDescriptionPanel.tsx` | 共享子组件：渲染 humanDescription；pending=true 时显示 Skeleton |

**props 主要签名**：
```ts
interface PermissionPromptProps {
  promptId: string;
  toolName: string;
  args: unknown;
  humanDescription?: string;
  humanDescriptionPending?: boolean;
  onResolve(decision: 'allow' | 'deny'): void;
}

interface AskChoicePromptProps {
  promptId: string;
  question: string;
  humanDescription?: string;
  humanDescriptionPending?: boolean;
  options: Array<{
    label: string;
    humanDescription?: string;
    preview?: string;
  }>;
  multiSelect: boolean;
  allowCustom?: boolean;
  onResolve(answers: string[], customText?: string): void;
}
```

#### Settings 子窗

左侧 vertical nav + 右侧表单内容。

| 文件 | 职责 |
|---|---|
| `src/components/settings/SettingsPanel.tsx` | 整个设置子窗。左 nav + 右 content。section state 跟着 URL hash 或 local state |
| `src/components/settings/SettingsNav.tsx` | 左侧导航：服务来源 / 模型绑定 / 角色卡 / Live2D / 快捷键 / 关于 |
| `src/components/settings/sections/ProvidersSection.tsx` | provider 列表 + 添加按钮 + 编辑/删除/健康检查 |
| `src/components/settings/sections/ProviderEditor.tsx` | 添加/编辑一个 provider config（baseUrl/apiKey/capabilities） |
| `src/components/settings/sections/ModelBindingsSection.tsx` | 11 个 module（chat/narrative/agent/...）的绑定配置；每个 module 一行 |
| `src/components/settings/sections/BindingRow.tsx` | 单 module 行：provider 选择 + model 选择 + 可选 voice_id |
| `src/components/settings/sections/CardsSection.tsx` | 角色卡列表 + 新建 + 切换激活 |
| `src/components/settings/sections/CardEditor.tsx` | 角色卡编辑器。**3 tabs**：身份 / 行为 / 音色 |
| `src/components/settings/sections/card-tabs/IdentityTab.tsx` | name + description + system_prompt 编辑 |
| `src/components/settings/sections/card-tabs/BehaviorTab.tsx` | speech_patterns + forbidden_topics + emotion_vocab + motion_vocab |
| `src/components/settings/sections/card-tabs/VoiceTab.tsx` | refAudios 列表（上传 / 试听 / 删除 / 选 primary）；调 `cards-voice.ts` API |
| `src/components/settings/sections/Live2DSection.tsx` | live2d_models 列表 + 上传 / 选择 |
| `src/components/settings/sections/ShortcutsSection.tsx` | 全局热键（V1.5） |

### 3.8 共享 layout

| 文件 | 职责 |
|---|---|
| `src/components/layout/SubWindowLayout.tsx` | 子窗壳：可选 Tauri 标题栏 + 内容容器 + 全局键盘快捷键 |

### 3.9 导出

`src/index.ts`：
- 所有顶层组件（ChatPanel / SettingsPanel / FloatingDock）
- 所有 store hooks（useChatStore 等）
- 所有 API 客户端工厂
- 类型

---

## 4. `apps/desktop/` — 极薄壳（更新已有）

**职责**：Tauri 集成、窗口生命周期、把 desktop-ui 组件挂载到对应窗口。不写业务组件。

### 4.1 主窗

| 文件 | 职责 | 变更 |
|---|---|---|
| `src/main.tsx` | React 入口 | 不变 |
| `src/App.tsx` | 主窗根：`<DragLayer/>` + `<GlowBorder/>` + `<Live2DStage modelPath={EMA_MODEL}/>` + `<FloatingDock visible={hover} onAction={dispatch}/>` + `<SidecarBadge/>` | **重写**：去掉所有 inline style，全 UnoCSS；导入 desktop-ui 的 FloatingDock；处理 Tauri actions（pin / passthrough / quit / open_window） |
| `src/components/DragLayer.tsx` | 全屏 `data-tauri-drag-region` div，z-index 0 | 新建 |
| `src/components/GlowBorder.tsx` | 粉白呼吸光边框 | 新建（从 App.tsx 抽出） |
| `src/components/SidecarBadge.tsx` | 左上角状态点 + tooltip | 新建（从 App.tsx 抽出） |

**删掉**：
- `src/components/Live2DStage.tsx` → 迁到 `packages/live2d-react`
- `src/components/FloatingDock.tsx` → 迁到 `packages/desktop-ui`

### 4.2 子窗入口

| 文件 | 职责 |
|---|---|
| `src/windows/chat.tsx` | 渲染 `<ChatPanel/>`（来自 desktop-ui） |
| `src/windows/settings.tsx` | 渲染 `<SettingsPanel/>` |
| `chat.html` / `settings.html` | 子窗 HTML 入口（已存在） |

**删掉**：
- `voice.html` / `src/windows/voice.tsx` —— voice 跟着角色卡走，不独立

### 4.3 API 桥（Tauri 命令）

| 文件 | 职责 |
|---|---|
| `src/api/tauri-bridge.ts` | wrap Tauri invoke：`getSidecarPort()`、`setAlwaysOnTop(b)`、`setPassthrough(b)`、`quit()`、`openWindow(label)` |
| `src/api/sidecar-status.ts` | 已存在；改用 desktop-ui 的 sidecar-store |

### 4.4 样式

| 文件 | 职责 |
|---|---|
| `src/styles/uno.css` | UnoCSS 入口 `@unocss preflights/default/utilities`（被 main.tsx 引入） |

### 4.5 配置变更

| 文件 | 变更 |
|---|---|
| `package.json` | 加 deps：`@ema-agent/ui`、`@ema-agent/live2d-react`、`@ema-agent/desktop-ui`、`unocss`；删 `pixi.js`、`pixi-live2d-display`（迁到 live2d-react） |
| `vite.config.ts` | 加 `unocss/vite` 插件；rollupOptions.input 删 `voice` |
| `src-tauri/tauri.conf.json` | 删 `voice` 窗口；保留 chat / settings |

---

## 5. ChatInput 圆形发送按钮规范（**重要 UI 细节**）

**位置**：textarea **内部** 右下角，absolute-positioned，距右边/底边各 8px。
**形状**：完美圆形（border-radius 50%），不是圆角矩形。
**尺寸**：默认 32px × 32px。
**默认状态**：底色 = 粉白 30% 不透明，图标 = ↵。
**有内容**：底色 = 粉白 80% 不透明 + 微微 glow。
**hover**：scale 1.08 + 粉白 100%。
**发送中**：图标换 Spinner（size sm）。
**禁用**：底色透明、图标 30% 不透明、不可点击。
**快捷键提示**：button 的 Tooltip 显示 "Ctrl + ↵ 发送"。

```
┌────────────────────────────────────────────────────┐
│ 输入消息…                                          │
│                                                    │
│                                              ╭───╮ │
│                                              │ ↵ │ │  ← 圆形 IconButton
│                                              ╰───╯ │     8px 内边距
└────────────────────────────────────────────────────┘
 📎  🎤  🔊TTS  💬Chat ▾                              ← 工具栏在 textarea 下方
```

**实现要求**：
- `Textarea` 组件支持 `embeddedAction?: ReactNode` prop
- ChatInput 把 `<IconButton icon="↵" />` 作为 embeddedAction 传入
- Textarea 内部把 embeddedAction 渲染成 absolute bottom-right
- Textarea 自身有右下角 32+16=48px padding 让出空间防止文字被按钮遮

---

## 6. 圆角规范（全局 token）

UnoCSS preset 里定义 design tokens：

```ts
theme: {
  borderRadius: {
    'sm':   '6px',   // 小元素：tag、徽章
    'DEFAULT': '8px',  // 默认按钮、input
    'md':   '10px',  // 多数 Card
    'lg':   '14px',  // Dialog / Popover / 设置面板
    'xl':   '20px',  // 主窗
    'pill': '9999px', // pill 按钮
    'full': '50%',    // 圆形
  }
}
```

**强制规则**：
- 任何视觉容器 `border-radius >= 6px`
- 输入框、按钮、popover、卡片 **不允许** `border-radius: 0`
- 圆形元素用 `rounded-full`
- 主窗本身也圆角（在 GlowBorder 里实现）

---

## 7. 执行顺序（10 步）

| # | 任务 | 依赖 | 验收 |
|---|---|---|---|
| 1 | 建 `packages/ui` 骨架 + UnoCSS preset + cn() | — | `pnpm install` 成功 |
| 2 | ui: 写 Button + IconButton + Ladle 故事 | 1 | `pnpm --filter @ema-agent/ui ladle` 出页 |
| 3 | ui: 补全所有原子组件 + stories | 2 | Ladle 里能看到每个组件 |
| 4 | 建 `packages/live2d-react`，迁移现有 Live2DStage | — | live2d-react typecheck 过 |
| 5 | live2d-react: 实现 MotionManager 插件管线 + 渲染守卫 + live2d-store | 4 | typecheck 过 |
| 6 | 建 `packages/desktop-ui` 骨架 + sidecar-store + chat-store + send-queue + API 客户端 | 1, 4 | typecheck 过 |
| 7 | desktop-ui: 重写 FloatingDock（用 ui/IconButton） | 6 | typecheck 过 |
| 8 | desktop-ui: 写 ChatInput + Textarea 内嵌圆形 send + ChatToolbar | 6 | Ladle 故事跑通 |
| 9 | `apps/desktop` 瘦身：删旧组件、加 UnoCSS、App.tsx 重写、删 voice 子窗 | 7, 8 | `tauri:dev` 跑起来 |
| 10 | 全仓 `pnpm -r typecheck` 全绿 | all | CI green |

之后才进 Phase 1（接 SSE + 真聊天）。

---

## 8. 不做（明确范围）

- ❌ Vue 混用（永久）
- ❌ inline style（永久）
- ❌ 顶部 mode tabs（永久 —— mode 在工具栏）
- ❌ 独立 voice 子窗（永久 —— voice 在角色卡里）
- ❌ DuckDB-WASM / Web Worker / Capacitor（V1）
- ❌ i18n / PWA / 多 app（V1）
- ❌ Plan usage 看板（永久，我们没订阅）

---

## 9. 文件总数预估

| 包 | 文件数（不含 stories / tests） |
|---|---|
| packages/ui | 17 组件 + 配置 ≈ 25 |
| packages/live2d-react | 12 文件 |
| packages/desktop-ui | 60+ 文件（业务组件多） |
| apps/desktop 改动 | ~10 文件 |
| **总计** | **~110 新/改文件** |

Phase 0 跑完是 step 1-10 的 **40 个文件**（不含 stories）。Phase 1 才把剩下 70 个 chat/settings 业务组件填满。
