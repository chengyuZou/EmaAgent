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

工具输出保留原始行结构, 除非所用查看器自行提供换行. 终端输出和文件代码可以横向滚动. `CodeViewer` 和差异查看器管理自己的滚动区域, 外层工具正文不能再叠一条纵向滚动条. 工具输出通常通过 `--ema-tool-body-max-height` 限制高度.

`ToolCallBlock` 管理标题, 状态, 耗时和展开. `ToolPane` 管理输入/输出工具栏和复制操作. 各工具的 `UI.tsx` 提供具体内容. 嵌入式代码查看器不再添加另一套标题和复制栏.

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
