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

1. 简单的局部布局直接使用 utility 类. 同一业务域的控件皮肤, 多状态样式或连续动画放到已有的 `domains/` 文件, 不在 TSX 中维护成组的样式映射.
2. 是**全 App 的变量或通用动画/过渡** → `src/ui/styles/foundation/`(tokens.css 或 animations/transitions.css)。
3. 是**跨业务的构件**(两个以上域在用) → `src/ui/styles/primitives/` 对应文件, 没有合适的才新开。
4. 是**单业务专属** → `domains/` 里那个域的文件; 该域还没有文件才新建 `<domain>.css`。
5. 是**适配第三方库的固定类名** → `vendors/`。

伪元素, 遮罩, 动画 calc(如 `var(--stagger-i)*40ms`), 滚动条和第三方类名适配也放到对应样式文件. 桌面通知的变体通过 `data-variant` 选择 `domains/toast.css` 的样式, TSX 只提供状态和内容.

## Tool 展示

- `ToolCallBlock` 统一名称、状态、耗时和展开行为. `ToolPane` 统一输入/输出工具栏、复制按钮及两侧间距. `UI.tsx` 只提供工具特有内容, 不给正文预留复制按钮空栏.
- `ArgsView` 和 `ResultView` 分别选择, 缺省或返回 null 的区域使用通用 CodeViewer. 对象和数组展示完整 JSON, 普通字符串展示纯文本; 需要 Markdown 的工具由专用 UI 明确渲染. `CallView` 保留命令与执行过程放在一起的终端布局.
- CodeViewer 在 Tool 内使用 `embedded`, 不显示自己的卡片、标题和复制按钮; Data 的独立查看器保留这些操作. Tool 正文使用 11px 等宽字体和弱强调文字颜色, JSON 保留语法色.

- 输入参数和生成中的参数按区域宽度强制折行, 长路径、URL、连续字符不能横向撑开卡片. 保留原文换行和缩进.
- 默认 JSON/纯文本输出、Narrative 和 WebFetch 正文通过 CodeViewer 自动折行. 专用终端日志、错误、文件代码、Diff 和 Markdown 保留原文换行, 长行在结果区或代码块内横向滚动.
- 通用与专属 Tool 都消费 `ToolPane` 的 input/output 规则(`domains/toolRow.css`). Bash/PowerShell 的命令输入和输出在 `domains/terminalCard.css` 保持同一口径.
- 输入最大高度 8rem, 输出最大高度由 `--ema-tool-body-max-height: min(60vh, 24rem)` 控制. CodeViewer 自己滚动时, 外层不叠加纵向滚动条; Narrative 各周目默认收起, 展开时挂载, 收起动画结束后卸载.
- 折叠行标题仍使用单行省略. 普通聊天 Markdown 不受 Tool 输出规则影响.
- Read 源码使用独立行号栏与公共 Markdown 代码块. 行号取自结果里的真实文件编号, 不混入源码高亮或文本选择; 两列共用纵向滚动, 只有源码横向滚动. Markdown 正文与 HTML 沙箱预览不加行号.

## 硬规矩

- Turn 失败使用 `chatHistory.css` 的 `.ema-turn-error`, 在该轮正文与工具内容之后、文件变更与 Footer 之前显示. 只有 failed 显示, 手动停止不显示错误. 错误按纯文本自动换行, 长错误预览最多八行, 展开后显示完整内容; 不受 Tool 输出横向滚动规则影响.

- 审查 Panel 的 `domains/review.css` 只影响工作区变更. 源码与统一/分列布局交给 `@pierre/diffs` CodeView, 默认不自动换行; 每份差异由库提供横滚, 整体视口负责纵滚.
- 范围选择复用 UI 包的 Select; 工具栏依次为刷新、换行、展开/折叠全部、统一/分列、显示/隐藏文件树. 批量折叠一次提交给 CodeView, 不重查 Git 或改变文件标识.
- 文件标题整条可点击展开/折叠, 复制路径和打开文件不触发折叠; 仍复用 UI 包的 Button、IconButton 和 Tooltip, 不嵌套按钮. 差异高度不做展开动画, 避免与官方虚拟布局争抢高度.
- Review 和工作区文件浏览器都使用 `@pierre/trees` 的 compact 密度和官方图标. `vendors/fileTree.css` 共用主题、紧凑间距和整个树视口底部的横滚; 不单独给树行加滚动条. 树常驻并以宽度/透明度双向折叠, 隐藏时不接受键盘焦点.
- File 页由 `domains/files.css` 负责预览/目录两栏. 空白入口原位替换为首个文件, 后续文件追加, 已打开文件按完整路径激活. 同一 Session 的文件标签共用一个目录模型; 目录只在展开时读取, 文件预览按标签 ID 保留.
- Trees 的原生横滚可见高度修正和宿主整数高度限制由同一份 pnpm 依赖补丁保存, 所有使用处共享; Review 只指定填满可用空间. 说明见仓库根目录 `patches/README.md`. 不固定像素高度, 不拦截滚轮或覆盖库的鼠标响应.

- main 的 Chat 和 Settings 共用 `frontend.wallpaper` 与 `wallpapers/` 图库. 文档根节点提供材质属性, 壁纸仅由主窗口的 WallpaperLayer 加载, 切换 View 不重复绘制图片.
- Stage 的气泡, 权限提示和菜单各自读取 `frontend.wallpaper` 的 `enabled` 与 `materialMode`. 关闭时使用普通主题表面; 开启时通过局部 `ema-stage-translucent` / `ema-stage-frosted` 类复用材质参数, 不修改文档根节点或加载壁纸图片. 主题和字体消费已有同步变量.
- `domains/main.css` 管理公共标题栏, 左侧主导航和 View 显隐. 隐藏 View 保留尺寸并设置 inert, 不卸载组件. 显隐同时使用 visibility 和 opacity, 防止侧栏子节点的 visibility 覆盖父节点隐藏状态. Chat 会话侧栏由 `workspace.css` 管理折叠动画; Settings 导航保持展开.
- 主窗口导航由 `layout/navigation.tsx` 保存. 访问记录只存会话 ID 或设置子页 ID, 当前窗口内最多保留 100 条, 不保存消息或表单副本. 返回和前进只移动 historyIndex; 打开新位置会删除当前位置之后的记录, 重复访问当前位置不追加. 新对话创建成功时替换原位置, 会话归档或删除后移除对应记录. 关闭主窗口只隐藏, 保留访问记录与已挂载 View; 退出应用后不保留这份内存记录.
- 外观导航分为主题, 壁纸和字体. 三个子页分别渲染 ThemeTab, WallpaperTab 和 FontTab, 仍使用原有主题与壁纸设置字段, 不分别保存新的设置副本.
- 桌面通知通过 `lib/notifications/toast.tsx` 挂在同一个窗口的 body 下, 不属于 Chat 或 Settings. `domains/toast.css` 按 `data-variant` 提供颜色和布局, 切换 View 不移动通知根节点或重新计时.
- 命名: 工具类 `ema-<动作>`(`ema-fade-in`); 构件类 `ema-<名>`; 域类 `ema-<域>-<件>`(`ema-tool-row`)。
- 文件按内聚职责组织, 不因行数拆分. 注释说明必要的样式约束与跨组件关系.
- 颜色, 间距, 圆角, 阴影一律走 `foundation/tokens.css` 的 token, 域文件里不写死色值; 亮暗主题差异只允许靠 token 覆盖, 不写主题分支判断。
