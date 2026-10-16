# @ema-agent/ui

桌面和 Tool UI 共用的组件与设计样式. 不保存 Session、Memory 等业务状态.

## Markdown

`Markdown` 是聊天、文件预览、Memory 文档与 Tool 输出共用的安全 Markdown 入口.

| 参数 | 含义 |
| --- | --- |
| `source: string` | Markdown 原文, 不包含额外的行号或传输信封. |
| `className?: string` | 添加到 `.markdown-content` 外层的业务样式类. |
| `streaming?: boolean` | 当前消息仍在生成. 默认 `false`; `true` 时未闭合的 Mermaid 围栏只显示源码和等待状态. |

围栏是否闭合来自现有 micromark 解析器的 token, 包括列表、引用和不同长度的围栏. 不是正则扫描第二遍原文. 消息完成后, EOF 结束的 Mermaid 围栏也允许绘图.

raw HTML 先经 `rehype-sanitize` 清洗, 然后执行 KaTeX 和代码高亮. Mermaid 代码不经过语法高亮, 由官方 Mermaid 解析和输出 SVG.

链接保留原来的 `href` 与外链行为, 聚焦或悬停时通过 `Tooltip` 显示完整地址. 原文提供的链接说明也显示在提示中, 不使用原生 `title` 提示框. 使用 Markdown 的应用根部需要挂载 `TooltipProvider`.

默认链接与桌面自定义链接共用 `MarkdownLink`. 它只负责地址提示和外链属性, 接受原生链接参数; 桌面在 `onClick` 中处理本地文件打开. 它不读取文件, 不决定哪些 URL 可以出现在 Markdown 中, URL 仍由 Markdown 的清洗规则和 Provider 的 `urlTransform` 判断.

桌面通过 `MarkdownRendererProvider` 提供图片点击、普通音频卡片和本地文件打开操作. Provider 传入的 components 只覆盖对应标签, urlTransform 必须拒绝脚本等不允许的协议; 其他 HTML 清洗规则保持不变. UI 包不读取本机文件, 也不导入桌面的 Viewer、AudioPlayer 或文件侧栏. 未设置 Provider 的 Markdown 保持默认显示方式.

## 只读文本与 JSON

`CodeViewer` 接收完整的 `source` 文本; `language="json"` 启用 JSON 高亮, 默认 `"text"` 显示纯文本. 当前用于 Data 的原始 Message JSON, Tool 的默认参数与结果, Narrative 的周目正文与原始输出, 以及 WebFetch 的结果正文. 工具卡仍保留周目分组, 状态和预览切换, 不替代图片、音频或其他专用交互.

```tsx
<CodeViewer source={formattedJson} language="json" />
<CodeViewer source={formattedJson} language="json" embedded />
<CodeViewer source={toolOutput} embedded wrapLines={false} />
```

默认显示独立卡片、文本类型和复制按钮. `embedded` 只显示文本区域, 由外层提供标题与复制操作, 不再套第二层卡片. Tool 使用内嵌展示, Data 使用独立展示.

CodeMirror 6 默认在高度不超过 `min(60vh, 36rem)` 的区域中连续滚动, 自动折行, 只把可视区及附近内容放入 DOM. 超长单行也由 CodeMirror 裁剪显示, 不要求调用方切成小段. 可以选中文本, 使用键盘导航, 或复制未截断的 `source`. 配色沿用 `--ema-syntax-*`, 材质由外层应用样式控制. `--ema-code-max-height`、`--ema-code-font-size` 和 `--ema-code-text` 允许宿主按 Tool 等紧凑区域设置高度、字号和正文颜色.

`wrapLines={false}` 保留原始行宽, 横纵滚动由同一个文本可视区处理, 横向滚动条位于该可视区底部. Tool 的结果正文使用此模式, 输入参数仍自动折行. 切换折行方式不重建编辑器或替换原文.

相同文本不会重新创建编辑器或替换文档; 文本变化时更新当前文档, 卸载时销毁编辑器. 调用方应在展开详情时挂载, 收起后卸载, 不把每条已读消息的查看器隐藏后长期留在页面中.

这只减少页面渲染量, 不减少 API 返回、JSON 解析或完整文本本身占用的内存. 数据读取、格式化与落盘由业务调用方负责.

## 悬停提示

应用根部挂载 `TooltipProvider`, 默认等待 200ms 后显示鼠标悬停提示. `Tooltip` 未传 `delayDuration` 时使用最近的 Provider 设置; 键盘聚焦可直接查看提示. `label` 用于短操作说明, `card` 用于地址、路径或多行只读预览, 两者共享主题、边框与动画. 长文本在可用窗口宽度内换行.

`Tooltip` 的子元素需要能接收 DOM ref 和事件. 它不会额外包裹布局元素, 也不改变子元素的点击行为. `content` 为 undefined、null 或空字符串, 或设置 `disabled`, 则保持子元素原样. 使用自定义提示时移除同一元素的原生 `title`, 图标按钮仍需保留 `aria-label`.

下拉菜单与 Popover 的触发按钮需要提示时, 使用它们的 `triggerTooltip`. 提示与点击事件在同一个按钮上组合, 不把 `Tooltip` 放进 `trigger` 来替代按钮. 提示内容保持只读, 含按钮等交互内容使用 Popover.

## 下拉菜单

`DropdownMenu` 的主菜单和子菜单使用内部列表滚动, 最大高度取 `24rem` 与窗口实际可用高度的较小值. 短菜单随内容决定高度, 长菜单保留可拖动的滚动条. 外层负责定位与展开裁剪动画, 不承担列表滚动. 子菜单仍通过点击展开, 模型列表等调用方保留各自的分组与选中标记.

## Mermaid 与 ELK

依赖固定为 `mermaid` 11.17.2 和 `@mermaid-js/layout-elk` 0.2.2. 流程图使用官方 ELK; 时序图等类型保持 Mermaid 自身的渲染器. 不自行维护布局或连线算法.

- 图块接近可视区域后才动态加载引擎, 当前预加载范围为 600px. 已开始展示的图不跟随滚动或面板宽度重画.
- 同一个图块的 React `useId`、源码与实际主题颜色/字体决定绘图缓存. 缓存包含进行中的 Promise 和失败结果, 最多 50 项, 先进先出. 不跨不同图块共享含 SVG ID 的字符串.
- `initialize` 与 `render` 作为同一个串行任务执行, 防止 Mermaid 全局配置串用. 测量容器临时挂在 body 下, 不参与业务布局; 任务结束后移除.
- 主题读取 UI 的正文字体、主题色、表面色和文本色. 明暗、主题色或字体变化时重新绘图; 图内配置不能覆盖应用主题或安全选项.
- 普通流程节点用圆角矩形, 判断节点用虚线边框矩形. 内边距 16, 水平文字边距 24, 最小高度 52. 节点间距 32, 层间距 44. 普通箭头使用开放式箭头, 圆头/交叉头等语义不变.
- SVG 使用 Mermaid `strict` 模式的内置 DOMPurify 清洗, 不调用图内脚本绑定. 解析失败显示源码; 图表/源码切换使用公共 `Button`.
- 宽度变化只由 CSS 缩放 SVG, 不触发布局计算. 首次绘图仍有官方库加载与布局成本, 并非后台 Worker 的零主线程开销.

`patches/@mermaid-js__layout-elk@0.2.2.patch` 仅将官方适配器遗漏的 `nodeSpacing` / `rankSpacing` 接到 ELK 的节点与层间距选项. pnpm 安装时统一应用. 不复制第三方算法, 不直接维护 node_modules.

## 验证

- `pnpm --filter @ema-agent/ui typecheck`
- `pnpm --filter @ema-agent/ui test -- tests/codeViewer.test.tsx`: 只读文档、长单行、原位更新、卸载及复制失败反馈. JSDOM 不负责验证实际滚动布局.
- `pnpm --filter @ema-agent/ui test -- tests/Tooltip.test.tsx`: 默认与单独设置的等待时间、只读提示、菜单和面板触发按钮的点击与焦点行为.
- `pnpm --filter @ema-agent/ui test -- tests/Markdown.test.tsx tests/mermaidRender.test.ts tests/mermaidIntegration.test.ts`
- `pnpm --filter @ema-agent/ui ladle`: 现有组件预览中的 `Markdown / Mermaid`, 覆盖分支、分组、时序图、错误回退、明暗与宽度切换、流式围栏.

集成测试执行真实 Mermaid/ELK, 但 JSDOM 的 SVG 文字测量被替代, 因此它不等于浏览器视觉或性能验收.
