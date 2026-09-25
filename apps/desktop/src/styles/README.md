# styles/ 分层规矩

唯一入口是 `index.css`，import 顺序即层级顺序：**foundation → primitives → domains → vendors**。禁止从组件里旁路 import 任何 CSS 文件。

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

## 硬规矩

- 命名: 工具类 `ema-<动作>`(`ema-fade-in`); 构件类 `ema-<名>`; 域类 `ema-<域>-<件>`(`ema-tool-row`)。
- 单文件 <200 行, 超了按职责拆; 文件头注释必须写清"谁在用我", 样式变了就更新注释。
- 颜色, 间距, 圆角, 阴影一律走 `foundation/tokens.css` 的 token, 域文件里不写死色值; 亮暗主题差异只允许靠 token 覆盖, 不写主题分支判断。
