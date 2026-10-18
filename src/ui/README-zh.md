# UI

[English](./README.md)

这个包提供桌面应用和工具结果共用的 React 控件, 浮层, 内容渲染器和主题样式. 调用方通过 props 传入值与正文, 通过 `onChange`, `onSelect` 等回调处理用户操作. 包内还提供修改浏览器主题变量的方法和 Provider 图标查询.

## 在应用中使用

组件从 `@ema-agent/ui` 导入, 主题方法从 `@ema-agent/ui/utils` 导入.

```tsx
import { CodeViewer, Markdown, TooltipProvider } from '@ema-agent/ui';

<TooltipProvider>
  <Markdown source={'# 报告\n\n已完成.'} />
  <CodeViewer source={'{"completed":true}'} language="json" />
</TooltipProvider>
```

导入组件不会自动加载应用样式. 仓库中的[桌面样式入口](../../apps/desktop/src/styles/index.css) 引入 `src/ui/styles/index.css`, 应用还要加载 `virtual:uno.css`. 显示公式的入口需要 `katex/dist/katex.min.css`.

[桌面的 UnoCSS 配置](../../apps/desktop/uno.config.ts) 展示了实际接法: 使用 `@ema-agent/ui/uno.config` 导出的 `emaSharedPreset`, `emaSharedTheme`, `emaSharedShortcuts` 和 `emaSharedSafelist`, 再补充应用图标集和扫描目录. 扫描范围要包含共享组件源码, 不能只扫描应用自己的文件. 完整写出的 `w-[500px]` 可以扫描, 运行时拼出的类名则需要 safelist 或其他明确样式.

共享 CSS 先加载主题变量与基础规则, 再加载构件样式, 包括字体, 表面层级, 颜色, 焦点反馈, 浮层, 滚动, Markdown 和减少动态效果的规则. 应用布局样式在后面加载.

## 控件与回调

| 入口 | 使用时需要知道的约束 |
| --- | --- |
| Button, IconButton | 默认 `type="button"`, loading 时不能触发操作. IconButton 必须有可读的 `label`, 悬停提示单独提供. |
| Field | 接收一个控件并关联标签, 说明与错误信息. 自定义子控件必须把 `id` 和 `aria-*` 传给实际可聚焦元素. |
| FilePicker | 增强一个按钮, 通过 `onSelect` 返回浏览器 `File[]`. 选完后清空原生输入值, 再次选择同一文件仍能触发回调. 本机路径选择使用宿主的对话框流程. |
| Dialog | 必须提供可见的 `title` 或 `ariaLabel`. ConfirmDialog 和 PromptDialog 在它上面提供确认与单行输入. |
| Tooltip, Popover, DropdownMenu | 触发元素需要接收 DOM ref 和事件. 菜单和 Popover 的提示使用 `triggerTooltip`, 不额外包一层按钮替换触发器. |
| Select, Combobox | 选项值由调用方稳定提供. Combobox 的键盘导航跳过禁用项, `allowFreeText` 将输入文字直接写回. 筛选结果目前全量渲染. |
| Slider, Tabs, Progress | 未知选中值和非法数字有明确的空态或回退. Slider 移动时调用 `onChange`, 提交时调用可选的 `onCommit`. |

TooltipProvider 默认悬停等待 200 ms. Tooltip 内容只读, 需要交互时使用 Popover. 提示为空或禁用时保留原来的子元素. DropdownMenu 在窗口可用高度内滚动, 子菜单通过点击而非悬停打开.

Textarea 根据内容和宽度变化测量自动高度. CursorFloating 在鼠标移动时直接更新 transform 与 CSS 变量; 入场动画放在外层, 避免动画的 transform 覆盖倾斜效果.

## Markdown 与媒体

`Markdown` 接收原文和可选的 `streaming`, 正常顺序为:

```text
Markdown, GFM, 公式与围栏 token
  -> raw HTML
  -> 安全清洗
  -> KaTeX 与代码高亮
  -> React 元素与 Mermaid 图块
```

原始 HTML 不能提供布局类名, ID, 内联样式或事件处理. 代码语言类名保留给高亮器. Mermaid 围栏使用现有 Markdown 解析器的 token 判断, 包括列表和引用里的围栏.

宿主通过 `MarkdownRendererProvider` 提供媒体组件, 链接操作和 `urlTransform`. 只覆盖传入的标签. 自定义 URL 方法会接管 `href` 与 `src` 的协议判断, 必须拒绝脚本地址及其他不支持的协议; 其余 HTML 清洗继续生效. 本机文件加载和导航由宿主回调处理.

`MarkdownLink` 保留链接行为, 用 Tooltip 显示地址. 默认渲染器和桌面自定义链接共用它, 上层需要挂载 TooltipProvider.

流式消息里未闭合的 Mermaid 围栏只显示原文和等待状态. 消息结束后, 以 EOF 结束的围栏也允许绘图.

## Mermaid 绘图

图块接近可视区域时按需加载 Mermaid 和 ELK. 绘图等待文档字体就绪, 临时创建 DOM 容器测量文字, 完成后移除.

初始化会修改 Mermaid 的共享配置, 因此初始化和绘图放在同一个串行任务中. 缓存按图块 ID, 原文和实际主题区分, 最多保留 50 项, 包含进行中的任务和失败结果. 不同图块不共享带有元素 ID 的 SVG 字符串.

SVG 使用 strict 模式清洗, 不绑定图内脚本回调. 图内设置不能覆盖应用保护的主题和安全选项. 解析或布局失败时显示原文和错误提示. 主题变化会重画, 面板宽度变化只由 CSS 缩放现有 SVG.

流程图使用 ELK 并应用本项目的节点和箭头外观, 其他图形使用 Mermaid 自身的渲染器. [ELK 适配器补丁](../../patches/@mermaid-js__layout-elk@0.2.2.patch) 将节点间距与层间距传给依赖, 不在组件中另写布局算法.

## 只读文本与 JSON

`CodeViewer` 使用 CodeMirror 6 显示纯文本或 JSON. 输入仍是完整原文, 页面只渲染可视区和附近内容, 复制使用完整原文. `embedded` 隐藏外层标题和复制按钮, `wrapLines={false}` 让横纵滚动由同一个可视区处理.

原文变化时更新已有编辑器, 语言和折行变化时重新配置, 卸载时销毁. 详情展开时挂载, 收起时卸载, 不为每条历史记录长期保留隐藏的编辑器.

这减少的是 DOM 渲染量, 不是 API 响应, JSON 解析或完整文本占用的内存.

## 主题与图标

`setThemeHue` 和 `setThemeRadius` 修改文档根元素的 CSS 变量. 色相循环到 `[0, 360)`, 圆角倍率限制在 `[0, 3]`. 调用方负责保存偏好并在启动时恢复. 明暗模式使用 `data-theme="light"`, 代码配色使用 `data-syntax-theme`.

Provider 图标身份在[注册表](./icons/providers/registry.ts) 中映射为类名, 导出的 safelist 覆盖注册图标与默认图标. 宿主提供实际图标集, 用户可选择但静态扫描看不到的额外图标也要由宿主加入 safelist.

## 阅读和验证

先看组件的 props 和回调, 再看对应 CSS. 内容渲染部分将 Markdown, MermaidBlock, mermaidRender 与 CodeViewer 连起来看. `components/*.stories.tsx` 提供交互示例.

```bash
pnpm --filter @ema-agent/ui typecheck
pnpm --filter @ema-agent/ui test
pnpm --filter @ema-agent/ui build
pnpm --filter @ema-agent/ui ladle
```

测试覆盖无障碍名称, 字段关联, 选中值边界, 提示, 文本框自动高度, Markdown 清洗, CodeViewer 生命周期和 Mermaid 排队. Mermaid 集成测试运行真实依赖, 但替代了 jsdom 缺少的 SVG 测量, 不能代替浏览器中的滚动, 颜色, 动画或原生窗口验收.
