# styles/ 分层规矩

唯一入口是 `index.css`，import 顺序即层级顺序：**foundation → primitives → domains → vendors**。禁止从组件里旁路 import 任何 CSS 文件。

Diff 的 shadow root 是例外: 全局样式无法进入它, ReviewPanel 和内置文件 Tool 共用 builtin-tools 导出的 `fileDiff.css`, 以字符串传给官方 `unsafeCSS`, 不旁路注入页面样式.

**设计系统层(foundation + primitives)住在 `src/ui/styles/`**: 它们是跨应用的组件皮肤, ui 包自携带后 Ladle 与 App 同源消费, ui 包不反向依赖任何业务包。本目录(domains + vendors)只留应用专属样式。

## 四层定义

| 层 | 位置 | 管什么 | 例子 |
|---|---|---|---|
| `foundation/` | `src/ui/styles/` | 影响全 App 的地基: 设计变量, reset, 动画/过渡工具类 | tokens, base, keyframes, animations, transitions |
| `primitives/` | `src/ui/styles/` | 跨 2 个以上业务域的共享构件类 | 玻璃, 卡片纹饰, 控件皮肤 |
| `domains/` | 本目录 | 单业务域专属样式, 文件名 = 域名 | toolRow, terminalCard, characterStage |
| `vendors/` | 本目录 | 第三方库的类名适配(hljs, Radix 这类类名不归我们定的) | hljs-theme |

## 新样式去哪(按顺序自问)

1. **utility/Tailwind 类能拼出来** → 不落 CSS 文件, 直接写在组件 className 里。
2. 是**全 App 的变量或通用动画/过渡** → `src/ui/styles/foundation/`(tokens.css 或 animations/transitions.css)。
3. 是**跨业务的构件**(两个以上域在用) → `src/ui/styles/primitives/` 对应文件, 没有合适的才新开。
4. 是**单业务专属** → `domains/` 里那个域的文件; 该域还没有文件才新建 `<domain>.css`。
5. 是**适配第三方库的固定类名** → `vendors/`。

只有 utility 表达不了的东西才值得落 CSS 文件: 伪元素, 遮罩, 动画 calc(如 `var(--stagger-i)*40ms`), 滚动条, 第三方类名。

## Tool 内容换行

- 输入参数和生成中的参数按区域宽度强制折行, 长路径、URL、连续字符不能横向撑开卡片. 保留原文换行和缩进.
- 输出正文、日志、错误、代码、Diff 和 Markdown 不自动折行. 保留原文换行; 长行在结果区或代码块内横向滚动.
- 通用与专属 Tool 都消费 `ToolPane` 的 input/output 规则(`domains/toolRow.css`). Bash/PowerShell 的命令输入和输出在 `domains/terminalCard.css` 保持同一口径.
- 折叠行标题仍使用单行省略. 普通聊天 Markdown 不受 Tool 输出规则影响.
- Read 源码使用独立行号栏与公共 Markdown 代码块. 行号取自结果里的真实文件编号, 不混入源码高亮或文本选择; 两列共用纵向滚动, 只有源码横向滚动. Markdown 正文与 HTML 沙箱预览不加行号.

## 硬规矩

- 审查 Panel 的 `domains/review.css` 只影响工作区变更. 源码与统一/分列布局交给 `@pierre/diffs` CodeView, 默认不自动换行; 每份差异由库提供横滚, 整体视口负责纵滚.
- 范围选择复用 UI 包的 Select; 工具栏依次为刷新、换行、展开/折叠全部、统一/分列、显示/隐藏文件树. 批量折叠一次提交给 CodeView, 不重查 Git 或改变文件标识.
- 文件标题整条可点击展开/折叠, 复制路径和打开文件不触发折叠; 仍复用 UI 包的 Button、IconButton 和 Tooltip, 不嵌套按钮. 差异高度不做展开动画, 避免与官方虚拟布局争抢高度.
- Review 和工作区文件浏览器都使用 `@pierre/trees` 的 compact 密度和官方图标. `vendors/fileTree.css` 共用主题、紧凑间距和整个树视口底部的横滚; 不单独给树行加滚动条. 树常驻并以宽度/透明度双向折叠, 隐藏时不接受键盘焦点.
- File 页由 `domains/files.css` 负责预览/目录两栏. 空白入口原位替换为首个文件, 后续文件追加, 已打开文件按完整路径激活. 同一 Session 的文件标签共用一个目录模型; 目录只在展开时读取, 文件预览按标签 ID 保留.
- Trees 的原生横滚可见高度修正和宿主整数高度限制由同一份 pnpm 依赖补丁保存, 所有使用处共享; Review 只指定填满可用空间. 说明见仓库根目录 `patches/README.md`. 不固定像素高度, 不拦截滚轮或覆盖库的鼠标响应.

- 命名: 工具类 `ema-<动作>`(`ema-fade-in`); 构件类 `ema-<名>`; 域类 `ema-<域>-<件>`(`ema-tool-row`)。
- 单文件 <200 行, 超了按职责拆; 文件头注释必须写清"谁在用我", 样式变了就更新注释。
- 颜色, 间距, 圆角, 阴影一律走 `foundation/tokens.css` 的 token, 域文件里不写死色值; 亮暗主题差异只允许靠 token 覆盖, 不写主题分支判断。
