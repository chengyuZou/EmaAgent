# TTS 流式文本过滤管道

`packages/tts/src/streaming/` 下的两个模块共同构成 TTS 文本清洗管道。本文描述它们各自的职责、设计决策与已知局限。

---

## 为什么需要两层

LLM 以 delta chunk 的形式输出文本，代码块的开头（` ``` `）和结尾可能分散在不同的 chunk 里。无状态 regex 无法跨 chunk 匹配，所以需要一个有状态的流处理器在前。完整句子内的行内 markdown（`**bold**`、`` `code` ``、URL 等）不跨句，无状态 regex 足够，在后处理。

> **ACT 标签**（`<|ACT:emotion:happy|>`）由 `@ema-agent/emotion` 包在 engine 内先处理。
> apps/core 只把已经剥离 ACT 标签的可见 `output_text_delta` 喂给 TTS。
> 因此 filterSentenceForTts 不再包含 ACT 清理逻辑。

```
visible output_text_delta
    │
    ▼  (EmotionEngine 剥离 ACT 标签，高优先级)
    │
    ▼
TextFilterStream.feed()        ← 有状态，块级清洗（代码块、数学块）
    │  普通文本零延迟透传（非行首批量扫描优化）
    ▼
SentenceSplitter.feed()        ← 有状态，句子边界检测
    │  每次 yield 一个完整句子
    ▼
TtsClient.synthesize()
    └─ filterSentenceForTts()  ← 无状态，行内 markdown 清洗（含快速路径）
    │
    ▼
TTS adapter（GPT-SoVITS / OpenAI / DashScope）
```

两层的分工原则：**只要需要跨 chunk 状态就属于第一层，能在完整句子上用 regex 解决的属于第二层。**

---

## TextFilterStream（有状态层）

### 职责

接收 engine 已清洗后的可见 text delta，识别并丢弃块级结构（fenced code block、`$$` 数学块），在块关闭时 emit 一个简短的替换词，普通文本直通。

### FSM 状态

| 状态 | 含义 | 进入条件 | 退出条件 |
|---|---|---|---|
| `normal` | 正常文本，监控行首 fence / `$$` | 初始 / `in_closer` 收到 `\n` | 见下 |
| `in_opener` | 已见到 opener（` ``` ` 或 `$$`），吃掉语言标识行 | `normal` 确认 opener | 收到 `\n` |
| `fenced_code` | ` ``` ` / `~~~` 块内，全部丢弃 | `in_opener` 收到 `\n`（fenceChar ≠ `$`） | `in_closer` |
| `math_block` | `$$` 块内，全部丢弃 | `in_opener` 收到 `\n`（fenceChar = `$`） | `in_closer` |
| `in_closer` | 已见到 closer，吃掉 closer 行剩余 | `onFenced` / `onMath` 确认 closer | 收到 `\n` → `normal` |

### 状态转换图

```
                  行首 3+ 个 ` 或 ~
normal ──────────────────────────────► in_opener
  ▲                                        │ \n（fenceChar ≠ $）
  │                                        ▼
  │                               fenced_code
  │                                        │ 行首 3+ 个同类字符
  │              \n                        ▼
  ◄──────────── in_closer ◄─────────── （emit 替换词）
  │                                        ▲
  │                               math_block
  │                                        │ 行首 $$
  │             行首 $$                    │
normal ──────────────────────────────► in_opener
                                           │ \n（fenceChar = $）
                                           ▼
                                       math_block
```

### 语言标识收集

opener 行（` ```python `）上的语言标识会被收集进 `langTag` 字段，在 closer 处调用 `codeReplacement()` 时使用：

| 有无标识 | chat 模式 | agent 模式 |
|---|---|---|
| 有（如 `python`） | `(python代码)` | `(python代码已省略)` |
| 无 | `(代码)` | `(代码已省略)` |

`langTag` 在进入下一个 opener 前会被重置，防止两个相邻代码块之间的标识串扰。

### 性能设计

`normal` 状态是热路径。**非行首时**采用批量扫描策略：用 `indexOf('\n')` 一次性定位下一个换行符，中间所有字符直接 `slice` 拼接，跳过逐字符 `step()` 调用。对于典型的 20-60 字符行，函数调用次数减少约 95%。

行首时仍需逐字符检测 fence opener（`` ` `` / `~` / `$`），但行首字符仅占总字符数的 ~5%（按平均行长 40 字符算），整体开销仍然很低。

代码块 / 数学块内的文本走快速路径：

```typescript
// fenced_code / math_block 状态，非行首时：
const nl = chunk.indexOf('\n', pos);
if (nl === -1) return out;   // 整个 chunk 剩余都是块内容，直接丢弃
pos = nl;
out += this.step(chunk[pos]!); // 只处理 \n
```

复杂度从 O(字符数) 降为 O(行数)，对长代码块（数百行）有明显收益。

### 关闭启发式规则

- **代码块**：行首 3+ 个与 opener **同类**字符即关闭，不要求数量完全匹配（LLM 有时输出 ```` ``` ```` 开但 ```` ` ```` 关）。反引号和波浪号不互相关闭。
- **数学块**：行首 `$$` 关闭，与 opener 相同。
- **未闭合**：流结束时 `flush()` 检测到仍在块内，emit 替换词兜底。

### `lineStartBuf` 的作用

行首最多缓存 2 个字符。第 3 个字符到达时可以判定是否是 fence opener（需要连续 3 个同类字符）。普通文本不会因此延迟超过 2 个字符。

---

## filterSentenceForTts（无状态层）

### 职责

接收 `SentenceSplitter` 切出的**完整句子**，用 regex 清洗行内 markdown。此时块级结构已处理完毕，只需处理单句内的模式。

### 处理顺序

顺序不可随意调换，部分步骤之间存在依赖：

| 步骤 | 处理内容 | 为什么在这里 |
|---|---|---|
| — | ~~ACT 标签~~ | 由 @ema-agent/emotion 包在高优先级处理，TTS 不再重复 |
| 1. MD 图片 | `![alt](url)` → `(图片)` | 在链接之前，避免 `[alt]` 被链接 regex 误拿 |
| 2. MD 链接 | `[text](url)` → `text` | 保留链接文字，丢弃 URL |
| 3. HTML 标签 | `<strong>` → `` | 去标签留内容 |
| 4. 行级标记（合并） | `#` `>` `-` `1.` → 合并为一个 RE_LINE_PREFIX | `gm` 模式，一次 replace 替代四次 |
| 5. 分隔线 / 表格 | `---` `\|` | 先删分隔行和表头分隔行，再换 `\|` 为空格 |
| 6. 粗体（合并）先于斜体 | `**text**` / `__text__` → `text`（合并 RE_BOLD） | `**` 含两个 `*`，斜体 regex 会误匹配 |
| 7. 行内代码 | `` `code` `` | agent 模式删除，chat 模式留文字；内容限 500 字符防回溯 |
| 8. 行内数学 | `$x^2$` `\(x\)` → `(公式)` | `$` 后接数字不匹配（防 `$100`） |
| 9. URL / 路径 | `https://...` `C:\...` `/etc/...` → `链接` / `路径` | 最后处理，避免 URL 内的 `[` `(` 干扰前面 |
| 10. 空白收尾 | `[ \t]+` → ` `，`\n{3,}` → `\n\n` | 折叠多余空白 |

### 快速路径（V1 性能优化）

`filterSentenceForTts` 入口处有一个轻量级字符检测：

```typescript
if (!/[<![\]*_`$#>\-~|:\\/]/.test(text)) return text.trim();
```

如果句子不包含任何 markdown / URL / 路径特征字符（覆盖大部分正常对话），直接 `trim()` 返回，跳过全部 regex replace。中文全角标点（`！？。，`）不匹配此检查，纯中文对话几乎 100% 命中快速路径。

### 正则合并

相比初版，以下 regex 已合并以减少 replace 调用次数：

| 合并前 | 合并后 | 减少调用 |
|---|---|---|
| RE_HEADING + RE_BLOCKQUOTE + RE_LIST_BULLET + RE_LIST_ORDERED | RE_LINE_PREFIX | 4→1 |
| RE_BOLD_STAR + RE_BOLD_UNDER | RE_BOLD（函数 replacer 选捕获组） | 2→1 |

### 行内代码的 `\1` 反向引用 + 长度限制

```
RE_INLINE_CODE = /(`{1,2})([^`\n]{1,500}?)\1/g
```

`\1` 要求开关反引号数量相同：单反引号开，单反引号关；双反引号开，双反引号关。这样 `` `code` `` 和 ` ``code`` ` 都能正确匹配，同时不会把 `` `a` b `c` `` 错误地当成一段。

`{1,500}?` 限制内容最长 500 字符，使用惰性匹配防止不成对反引号导致的灾难性回溯。

### 行内数学的 `$100` 豁免

```
RE_MATH_INLINE = /\$(?!\d)([^$\n]+)\$/g
```

`(?!\d)` 负向前瞻：`$` 后面紧跟数字时不匹配。`$100` `$3.99` 保留原文，`$x^2$` 替换为 `(公式)`。

---

## V1 已知盲区

这些情况在 V1 不处理，已记录为 TODO：

| 盲区 | 描述 | 影响 |
|---|---|---|
| 4 空格缩进代码块 | 无 opener/closer，FSM 识别不到 | TTS 读出代码（LLM 很少用此格式） |
| blockquote 内的代码块 | `> ` 前缀导致行首检测失效 | TTS 读出代码 |
| 嵌套 fence（外层 4 tick） | 内层 closer 误触发外层关闭 | 部分代码泄漏，`filterSentenceForTts` 兜底 |
| Reference-style 链接 `[text][ref]` | 定义与使用分离，sentence 级处理拿不到完整信息 | URL 不会被清理 |
| 跨行 `\(` LaTeX | `RE_MATH_LATEX_I` 只匹配单行 | 多行公式泄漏到 TTS |
| 路径/URL 语义化 | 路径一律替换为"路径"而非朗读路径内容 | 当路径是答案时信息丢失（V1.5 TODO） |

---

## 如何扩展

### 新增块级结构（在 TextFilterStream 里）

以假设要支持 `::: warning` / `:::` 这种容器块为例：

1. 在 `onNormal` 里检测行首 `:::`，设置 `fenceChar = ':'`，进入 `in_opener`
2. `onInOpener` 的 `\n` 转换逻辑里，按 `fenceChar === ':'` 进入新状态（或复用 `fenced_code`）
3. 关闭检测：行首 3 个 `:` 触发 `codeReplacement()`

### 新增行内 pattern（在 filterSentenceForTts 里）

1. 在模块顶层添加一个 `const RE_XXX = /pattern/g`（模块级，避免每次调用重新编译）
2. 在 `filterSentenceForTts` 里按正确顺序插入 `out = out.replace(RE_XXX, replacement)`
3. 如果新增字符在快速路径检测范围内，更新快速路径 regex 的字符类
4. 更新本文的处理顺序表，说明为什么放在这个位置
