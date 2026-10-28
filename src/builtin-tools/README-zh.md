# Builtin Tools

[English](./README.md)

这个包实现 Agent 可调用的本地文件和命令工具, 网页搜索与读取, 用户问询, Task 和 Goal, Memory 与 Narrative 查询, Skills, 子 Agent 和临时便笺, 并提供对应的桌面结果视图.

## 注册和执行

```ts
import { registerBuiltinTools } from '@ema-agent/builtin-tools';
import { assembleToolPool, ToolRegistry } from '@ema-agent/tools';

const registry = new ToolRegistry();
registerBuiltinTools(registry, { disableExecuteTools: true });
const pool = assembleToolPool(registry);
```

Server 启动时注册工具, Turn 准备时选择允许使用的子集并提供 `ToolUseContext`. 已注册不代表本次调用一定具备所需能力: 真正调用前由 `validateContext` 检查, 缺少能力时返回执行错误, 不让基础注册表随某个 Session 的环境变化.

[Tools](../tools/README-zh.md) 的公共执行流程校验输入, 检查上下文和权限, 执行工具, 保存结果并生成模型可见内容. 每个工具声明自己的输入 Schema, 所需上下文, 并发规则和结果转换. `ToolInvocation` 提供 Session, Turn, 调用 ID 和取消信号.

执行代码从包根入口导入. 前端使用 `@ema-agent/builtin-tools/ui`, 稳定身份使用 `@ema-agent/builtin-tools/identity`, Diff 的 shadow root 样式使用 `@ema-agent/builtin-tools/fileDiff.css`. UI 入口与 Node 执行依赖分开.

## 工具分类

| 分类 | 工具及行为 |
| --- | --- |
| 文件 | Read 返回文本, 图片, Notebook 单元或 PDF 正文. Write 写入全文, Edit 替换匹配字符串, Glob 查路径, Grep 用 ripgrep 查正文. |
| 命令 | Bash 使用宿主提供的 CommandRunner, PowerShell 启动本机程序. ProcessList, ProcessOutput 和 ProcessStop 操作当前 Session 的后台命令. |
| 网页 | WebSearch 返回标题, URL 和摘要. WebFetch 下载已知页面, 支持原始文本和按字符分页. |
| 用户交互 | AskUser 经宿主问询通道等待结构化回答, 不回退到终端输入. |
| 工作记录 | TodoWrite 在工具输入中替换当前 Turn 清单. Task 工具使用持久 Session 任务. Goal 工具带当前版本读取或更新用户已建立的目标. |
| 已有资料 | Memory 工具查询正式记忆文件, NarrativeSearch 查询固定剧情, Skill 从本次 SkillPool 加载 SKILL.md. |
| 子 Agent | Subagent 启动或继续一个身份, SubagentAwait 等待结果. Scratchpad 工具在 Turn 内共享有限额的临时文件. |
| 图片 | Capture 使用宿主截图. 主模型无法查看任务所需图片时, DescribeImage 显式调用已配置的 Vision 模型. |
| 电脑操控 | Windows 下的 ListWindows, ObserveWindow, ComputerAction 和 ComputerEnd 观察并操作桌面. 启动确认一次, 已授权控制中的操作不重复询问, 仍保留校验和 deny 规则. 用户输入暂停, Ctrl+Alt+C 继续, Esc 只结束控制而不取消 Turn. |

## 文件与命令

文件路径相对宿主提供的工作区解析, 不使用 Server 进程目录. 读写权限会检查显式规则, Session 批准, 工作区及敏感路径. Read, Write 和 Edit 即使获批也拒绝 UNC 路径. 破坏性命令警告只是说明, 不直接决定权限.

Read 将文本读取状态放进 Session 的 FileStateCache. Edit 允许先按范围读取, Write 覆盖已有文件则要求先读全文. 两者都会检查读取后文件是否改变. 同一进程内对规范路径串行写入, 先写同目录临时文件并同步, 再 rename 替换目标. 这个锁不能协调外部编辑器或其他应用进程. Edit/Write 返回实际补丁和增删行数供桌面显示. Read 文本一次保留最多 50 KiB 完整行, 超过 10 MiB 的文件必须按范围读取. 大文件仍扫描到末尾统计行数. 图片最多 5 MiB, Notebook 和 PDF 最多 50 MiB. PDF 默认读 10 页, 单次最多 20 页. OCR 和图注需要 Vision 及可选 canvas 渲染, 缺少能力时返回页级警告. 纯矢量图表目前不触发图注.

Glob 优先使用 `rg --files`, 不可用时回退 Node glob. Grep 要求安装 `rg`. 子进程读取限制时间, 字节数和记录数, 达到限制时返回部分结果. 排序及分页只针对已经收集的候选, 截断后不保证覆盖所有文件.

Bash 的注册可以单独关闭, 不影响 PowerShell. 没有操作系统沙箱时 Server 通常关闭 Bash. PowerShell 是本机进程, 不是隔离环境. 它使用原生解析器提取 AST, 不执行待分析命令. 两种工具仍经过公共权限流程, 静态检查不能替代操作系统隔离.

Bash 使用同步语法及模式检查, 另外通过 AST 提取子命令匹配规则. 解析失败, 动态参数或超过预算的输入不能作为按子命令规则放行的依据. TypeScript Bash 解析器有输入长度, 时间和节点上限. PowerShell 使用探测到的程序解析, 有平台相关的命令体积上限和有限 LRU Promise 缓存, 瞬时进程故障会移出缓存以便重试.

两种命令共用 BackgroundProcess. 短命令直接返回, 长命令不重启而是继续在后台执行. 取消和总时限由公共进程层处理, 后台引用包含 ID 及日志位置. 具体限额和退出流程见 [Tools](../tools/README-zh.md) 与 [Sandbox](../sandbox/README-zh.md).

## 网页, 已有资料与子 Agent

WebSearch 有支持的 Brave API-key 环境变量时使用 Brave, 否则读取 Bing HTML. 按返回 URL 过滤域名并去重, 保留服务端顺序, 最多返回 10 项. 不筛域名时只去掉查询首尾空白; 筛域名时追加搜索操作符, 返回后仍检查 URL. 搜索摘要不是网页正文.

WebFetch 把 HTTP 改为 HTTPS 并跟随重定向, 响应最多 10 MiB, 网络部分超时为 30 秒. 静态 HTML 提取后转为 Markdown, 不执行页面脚本或复用浏览器登录. 原始文本和转换结果分别缓存, TTL 为 15 分钟, 内容总额为 50 MiB. 预批准 GET 域名仍服从用户的权限规则. HTML 预览 iframe 使用空 sandbox 属性.

Server 启动时调用一次 `configureWebDownloads(activeDataDir)`. WebFetch 从 `ToolInvocation.sessionId` 取得归属, 保存到 `<activeDataDir>/web-fetch/<sessionId>/`; Read 识别受管下载根目录, 不经 Turn 上下文传递 Web 专用目录. WebFetch 用生成的文件名保存原始字节, 写完后才发布文件, 在 `download` 中返回绝对路径和 MIME 类型, 同时给模型返回下载说明. 不使用远端文件名, 不覆盖用户文件, 不对下载应用文本分页. Read 负责读取保存的 PDF 和支持的图片; 保存成功不代表其他格式也能读取. 只有 Read 获得这个受管目录的默认读取权限, 仍服从显式 deny/ask 规则并检查符号链接逃逸, 不放开其他数据目录.

下载缓存按 Session 的目标目录隔离, raw 与普通调用共用, 只有文件仍存在且体积相符才复用. 同一 Session 的主 Agent 和子代理共享文件, 其他 Session 不复用它的缓存下载路径. 内存缓存只保存说明, 不保存文件字节. 文件跨 Turn, 重启和缓存过期保留, 随所属 Session 删除并纳入会话备份. 当前没有下载文件的自动磁盘配额或过期删除. 下载仍与用户附件分开保存. 取消或写入错误会移除当前未完成文件; 进程异常退出可能留下 `.pending` 文件.

两个网页工具直接调用共用的 Web 请求实现. 连接在首次使用时创建, Server 进程中的主 Agent 和子代理共用. Server 退出时先取消运行中的工作, 再调用 `closeWebRequests()` 关闭连接. 请求使用独立 dispatcher, 不修改模型, MCP 或其他全局 `fetch` 请求. Bing 和 WebFetch 跟随重定向, 每个目标重新检查代理例外规则. Brave API 保持手动重定向, 不把 API 凭据转发到另一个 URL.

代理配置在首次创建 Web 连接时读取, 保持到连接关闭为止. 小写环境变量优先于同名大写变量. HTTP 依次选择 `HTTP_PROXY`, `ALL_PROXY`; HTTPS 依次选择 `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`. `NO_PROXY` 支持精确主机, 以 `.` 或 `*` 开头的后缀, 可选端口, 以及表示全部绕过的 `*`. 没有显式代理地址时, Windows 桌面宿主提供当前用户的固定系统代理与例外列表, 包括 `<local>` 和主机名通配符. PAC/WPAD, SOCKS, 无效配置或读取系统设置失败会明确报配置错误, 不悄悄直连. macOS, Linux 及单独启动的 Server 当前只读取环境变量配置. 修改代理后需要重启 Ema.

代理失败后不自动重试或回退直连. 网络错误通过 `ToolResult.errorCode` 保留安全的 DNS, 连接, 超时和 TLS 分类. 非 2xx 响应保留 HTTP 状态及有效的 `Retry-After`. 错误摘要最多读取 4 KiB, 等待至多一秒, 去掉标记和已知请求凭据后返回最多 500 字符的不可信文本, 不作为网页正文缓存. 用户取消仍按取消处理. 代理可用不代表获得网站访问权限, HTTP 读取也不等于交互式浏览器.

Memory 返回 Work 和 Relationship 中与用户有关的资料. NarrativeSearch 返回按可能相关周目分组的原作剧情及单独的失败说明, 不是对话记忆. 实际存储和检索由宿主查询函数决定. 工具结果对象与发给模型的文本可能不同, 改输出时既要看 `execute`, 也要看 `mapResultToModelContent`.

Subagent 前台等待超过 120 秒转到后台. 取消前台等待会取消该子 Agent, 已在后台的执行有自己的生命周期. Scratchpad 按目录串行写入, 最多 64 个 key, 每项 256 KiB, 合计 8 MiB. 它是 Turn 临时文件, 不能替代持久 Task 或最终交付文件.

## 阅读和验证

从 `index.ts` 看注册及导出, 再看具体工具的实现, `prompt.ts`, 可选的 `UI.tsx` 和测试. 网页请求, 正文提取和缓存/下载保存分别位于 `tools/WebFetchTool/network`, `content`, `storage`, WebSearch 复用请求实现. `tools/shared` 保存共用路径及 Shell 权限检查, AST 和命令模式检查位于对应 Shell 工具旁.

```bash
pnpm --filter @ema-agent/builtin-tools typecheck
pnpm --filter @ema-agent/builtin-tools test
pnpm --filter @ema-agent/builtin-tools build
```

普通测试使用临时文件, 测试数据库, 假命令执行器和模拟 HTTP 响应. 设置 `EMA_LIVE_PWSH=1` 后, `tests/PowerShellLive.test.ts` 会使用本机 PowerShell. 解析单元测试和 jsdom 视图测试不能证明完整的 Shell 安全性或原生窗口交互.
