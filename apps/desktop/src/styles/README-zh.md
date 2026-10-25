# Desktop 样式

[English](./README.md)

这里的样式把 Desktop 页面接到共享 UI 主题, 并适配第三方查看器. 共享变量, reset, 动画和可复用组件样式来自 [UI 包](../../../../src/ui/styles/index.css), Desktop 专用的布局和状态规则放在本目录.

## 加载方式

`index.css` 先导入共享 UI 样式, 再导入 Desktop 业务样式, 最后导入全局第三方样式及适配. 两个窗口入口都加载这份样式表.

另外有两种加载方式:

- `TerminalPanel.tsx` 随终端组件导入 xterm 自带样式.
- 文件树和差异查看器在 shadow root 内渲染, 页面 CSS 不能直接进入. Trees 通过 `unsafeCSS` 接收 `vendors/fileTree.css` 的字符串; Review 和文件工具共用 Builtin Tools 导出的差异样式.

不能把 shadow root 的适配文件移进全局导入表后, 就期待它能影响查看器内部.

## 应该改在哪里

| 修改内容 | 位置 |
| --- | --- |
| 颜色, 字体, 间距, 共享动画和可复用 UI 外观 | 仓库根目录下的 `src/ui/styles/foundation` 或 `src/ui/styles/primitives` |
| 主窗口标题栏, 导航和隐藏页面 | `domains/main.css` |
| 会话侧栏, 工作区标签和尺寸调整反馈 | `domains/workspace.css` |
| 聊天历史, 输入框, 工具行和工具终端输出 | 对应的 `domains/chat*.css`, `toolRow.css` 或 `terminalCard.css` |
| 壁纸透明度, 模糊和表面填充 | `material.css`, `materialSurfaces.css`, `chatMaterial.css` 和 `wallpaper.css` |
| Memory, 存储, 舞台, 文件或变更 | 对应的业务样式文件 |
| 第三方类名或 shadow root 内的树内容 | `vendors` |

简单局部布局可以用 TSX 工具类. 成组状态选择器, 伪元素, 遮罩, 动画和第三方适配放进对应样式文件. 普通 UI 颜色和尺寸使用共享主题变量. 色相渐变和图片查看器的明确几何尺寸按实际行为保留自己的数值.

## 容易改错的边界

### 隐藏页面和调整尺寸

Chat 和 Settings 保持挂载. 非活动页面保留布局尺寸, 同时隐藏 visibility 和 opacity, 由组件设为 inert. 这样不会用零尺寸重新计算消息位置和输入框高度. 原生浏览器 WebView 仍需要显式调用显隐接口, CSS 只能隐藏页面内容.

会话侧栏在指针调整宽度时关闭宽度过渡. 工作区面板同样关闭 `react-resizable-panels` 写入比例的过渡. 拖动中重新加上尺寸过渡, 会让分隔线落后于指针. 松手后恢复展开和收起动画.

### 聊天和工具正文

聊天 Markdown 的长行在内容列内换行. 工具输入也换行, 最大高度为 8rem.

工具输出保留原始行结构, 除非所用查看器自行提供换行. 每段文本结果, Markdown 文档, 进度和错误都显式使用 `.ema-tool-text-scroll`. 该区域按需横向和纵向滚动, 通过 `--ema-tool-body-max-height` 限高, 通常为 `min(60vh, 24rem)`. 输入区域使用 8rem 并对长行换行. `.ema-tool-result-details` 单独负责留白.

独立的 `CodeViewer`, HTML, 差异和终端查看器管理自己的滚动区域. `ToolPane` 只排列正文和工具栏, 不通过查找后代元素选择滚动规则. 因此 Markdown 内出现代码块不会取消整篇文档的滚动限制. 结果后附带错误时, 两段正文分别滚动, 总高度可以超过单段上限. Narrative 的各周目也保留独立查看器. 新增普通文本结果分支时, 需要显式添加文本滚动区域, 包括同一个工具的其他分支返回查看器的情况.

`ToolCallBlock` 管理标题, 状态, 耗时和展开. `ToolPane` 管理输入/输出工具栏和复制操作. 各工具的 `UI.tsx` 提供具体内容. 嵌入式代码查看器不再添加另一套标题和复制栏.

Read 源码视图和新建文件的 Write 结果共用代码字号, 行高及行号栏. Write 将完整新建内容交给 `CodeViewer`, 摘要留在输出工具栏. 工具栏标签保持单行, 摘要在剩余宽度内换行, 操作按钮保留自身宽度. 工具栏不跟随正文滚动.

较长的折叠正文在收起动画结束后卸载, 释放已经读取的内容. Review 差异高度由查看器的虚拟布局决定, 不再套一层高度动画.

Turn 失败使用回复和工具内容之后的 `.ema-turn-error`. 错误按纯文本换行, 不跟随工具输出的横向滚动规则.

### 材质和图片

`material.css` 定义填充和模糊参数, `materialSurfaces.css` 应用到结构表面与浮层. 嵌套卡片不各自叠加模糊. 背景 Alpha 与容器 opacity 分开, 避免文字和图片随背景一起变淡.

只有主窗口加载壁纸图片. 舞台气泡, 权限卡和菜单使用局部材质类, 共用设置但不加载壁纸, 也不修改舞台文档的材质属性.

替换图片前先等新图准备完成. outgoing 和 active 分开控制动画, 避免快速选图时出现空白.

### 第三方查看器

Review, 工作区文件和 Memory 共用树样式和[依赖补丁](../../../../patches/README.md). 横向滚动由整个树视口负责, 不单独给每行添加滚动条.

代码颜色跟随 `--ema-syntax-*`. 高亮适配保持背景透明, 由代码容器决定填充. 行内代码遵循所在段落的行高, 不使用块级代码行高.

## 如何检查样式修改

运行 Desktop build 检查 CSS 和导入错误. 再看真实页面的亮暗主题, 窄宽窗口, 键盘焦点和减少动画模式. 修改尺寸调整或原生浏览器相关行为时, 需要在 Tauri 窗口中检查. 构建通过不能证明滚动, 过渡和原生显隐体验正确.

运行 `pnpm --filter @ema-agent/desktop test:tool-scroll` 可单独执行浏览器回归. 测试用固定结果渲染真实工具卡和 Desktop 样式, 在两种窗口宽度下检查横纵滚动, 并阻止应用后端及外部请求. Windows 使用已安装的 Edge, 其他平台使用 Playwright Chromium. 测试不启动原生应用, 也不需要模型凭据.
