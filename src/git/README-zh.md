# @ema-agent/git

[English](./README.md)

通过系统的 Git 程序读取仓库信息和补丁. Ema 的桌面会话标题栏和审查面板使用查询函数, Memory 目录使用基线函数跟踪变化.

## 仓库查询

```ts
import { gitSummary, gitWorkspaceDiff } from '@ema-agent/git';

const cwd = '/path/to/repository';
const summary = await gitSummary(cwd);
if ('status' in summary) {
  console.error(summary);
} else {
  console.log(summary.branch, summary.untrackedCount);
}

const diff = await gitWorkspaceDiff(cwd, 'uncommitted');
if ('status' in diff) {
  console.error(diff);
} else {
  console.log(diff.patch, diff.omittedFiles);
}
```

查询函数从 `cwd` 向上查找可访问的 `.git` 目录或指针文件, 再从找到的目录执行 Git. 因此, 传入仓库子目录时, 查询范围仍是整个仓库. 命令执行时由 Git 检查仓库是否可读.

| 函数 | 返回类型 | 成功时返回的内容 |
| --- | --- | --- |
| `gitSummary(cwd)` | `GitSummaryResult` | 仓库根目录, 分支, 已跟踪文件的暂存和未暂存统计, 未跟踪文件数, upstream 和 origin 地址. |
| `gitWorkspaceDiff(cwd, scope)` | `GitWorkspaceDiffResult` | 仓库根目录, 原生 Git `patch`, 以及未能读取补丁的未跟踪文件数. |
| `gitCompareDiff(cwd, target)` | `GitCompareResult` | 仓库根目录, 指定提交或分支比较的原生 Git `patch`. |
| `gitRefs(cwd)` | `GitRefsResult` | 当前分支, 本地分支名, 以及从 HEAD 开始最多 50 条近期提交的完整 ID 和标题. |

`GitCommits` 是提交查询与 `GitRefsResult.commits` 共用的只读列表类型. 每项包含 `sha` 和 `subject`.

`gitSummary` 在取不到分支名时查询 `headShortSha`. detached HEAD 的 `branch` 为 `null`. upstream 和 origin 缺失或查询失败时返回 `null`. 未跟踪目录展开为单个文件后计数.

工作区 diff 的三个范围使用不同的比较起点:

| 范围 | 已跟踪文件 | 未跟踪文件 |
| --- | --- | --- |
| `uncommitted` | HEAD 到当前磁盘内容. | 包含. |
| `staged` | HEAD 到暂存区. | 不包含. |
| `unstaged` | 暂存区到当前磁盘内容. | 包含. |

`uncommitted` 显示相对 HEAD 的最终变化. 一个文件先暂存新内容, 再在磁盘上恢复成原内容时, 最终差异可能为空, 而暂存和未暂存范围各自仍有变化. 首次提交前使用空树作为比较起点, 空树 ID 由 Git 按仓库的对象格式计算.

比较提交时, `{ kind: 'commit', sha }` 读取 `git show` 为该提交生成的补丁. 比较分支时, `{ kind: 'branch', branch }` 先找出 HEAD 与所选分支的共同祖先, 再比较该祖先与当前已跟踪文件的磁盘内容. 分支比较包含已跟踪文件的暂存和未暂存变化.

### 返回状态和限制

成功查询直接返回数据字段, 失败结果携带 `status`. 读取数据前通过 `'status' in result` 判断是否失败:

- `not-a-repo`: 在 `cwd` 及其父目录中没有找到可访问的 `.git`.
- `git-unavailable`: 找不到 Git 程序, 无法启动命令.
- `diff-too-large`: 工作区或比较补丁超过体积限制, 或工作区查询发现过多未跟踪文件.
- `error`: 其他 Git 命令错误, 包括超时. `message` 说明失败的命令.

范围内没有变化时, 返回空补丁, 仓库根目录和 `omittedFiles`. 工作区查询将失败的未跟踪文件补丁命令计入 `omittedFiles`, 继续返回其余补丁. 空文件, 二进制文件, 重命名和权限变化的补丁头部都会保留. 审查查询超过限制时返回 `diff-too-large`, 不截断补丁正文.

[`errors.ts`](./errors.ts) 定义 `GitUnavailableError`, `GitTimeoutError`, `GitCommandError`, `GitOutputTooLargeError` 和 `GitDiffTooLargeError`. 查询将预期的失败转换为结果, 基线函数则向调用方抛出对应错误. 不认识的错误继续抛出. 进程输出限制与审查体积限制分别处理; 审查将两者都表示为 `diff-too-large`, 基线读取则在输出超限时标记正文不完整.

命令默认值位于 [`gitProcess.ts`](./gitProcess.ts), 审查限制位于 [`diff.ts`](./diff.ts), 基线限制位于 [`baseline.ts`](./baseline.ts):

| 限制 | 当前值 |
| --- | --- |
| 每条 Git 命令的默认超时 | 100 秒. 基线写入和基线存储清理使用 30 秒. |
| 每个输出流的默认缓冲上限 | 16 MiB. 审查补丁命令使用 8 MiB. |
| 审查补丁长度 | 2,000,000 个 JavaScript 字符串码元. |
| 工作区审查的未跟踪文件数 | 500. 每批最多用 8 条 Git 命令读取补丁. |
| 补丁上下文 | 3 行. |

## Memory 基线

基线是 Memory 目录独占仓库的当前 HEAD, 记录 Memory 整合上次接受的目录内容.

| 函数 | 行为 |
| --- | --- |
| `hasUsableBaseline(root)` | 检查从 `root` 执行 Git 能否解析 HEAD. |
| `ensureBaseline(root)` | 保留可解析的 HEAD, 否则尝试初始化仓库并提交当前目录内容. |
| `resetBaseline(root)` | 暂存当前的新增, 修改和删除, 然后创建首次提交或修改最后一次提交. |
| `diffSinceBaseline(root, options?)` | 返回当前 HEAD 到磁盘的文件变化清单和有长度限制的统一补丁, 包含未跟踪文件. |
| `compactBaselineStorage(root)` | 清理反复修改最后一次提交后留下的 reflog 条目和旧 Git 对象. |

调用方应传入已经存在且专供基线使用的目录, 该目录有自己的仓库, 或准备在其中建立独立仓库. Git 会向父目录查找仓库, 所以仅凭 HEAD 检查成功, 不能证明 `root` 有自己的 `.git`. 调用方需要提供正确的根目录, 并按顺序执行同一目录的操作. 重置基线会改变暂存区和 HEAD, 当前文件内容保持不变. 从单次提交建立的基线在反复修改后仍只有一条提交; 已有多条提交的仓库会保留更早的历史.

`diffSinceBaseline` 将文件清单与补丁正文分开查询. 重命名表示为删除和新增. 变化超过 200 项时, `unifiedSkipped` 为 `true`, 正文为空, 文件清单保留. 正文默认限制为 4 MiB UTF-8 文本, 可通过 `options.maxDiffBytes` 指定. `truncated` 表示正文因该限制或 Git 输出缓冲限制而不完整. 截断会保留完整的 UTF-8 字符. `omittedFiles` 记录失败的未跟踪文件补丁读取次数.

[`gitWorkspace.ts`](../memory/common/gitWorkspace.ts) 管理 Memory 的这些调用. 比较前先删除生成的 `memory_workspace_diff.md`, 再把新文件清单和补丁写入其中供整合读取, 接受变化前再次删除它. [`runConsolidationJobs.ts`](../memory/jobs/runConsolidationJobs.ts) 在应用整合修改后接受新基线. [Memory 维护](../memory/capacity/maintenance.ts)为内部仓库执行存储清理.

## 接入与检查

桌面通过 [`sessionGitApi`](../../apps/desktop/src/api/git.ts) 请求[会话 Git 路由](../../apps/server/src/routes/sessions/git.ts). Server 从会话取出 `cwd`, 将查询结果作为 JSON 返回. [`SessionHeader`](../../apps/desktop/src/chat/session/SessionHeader.tsx)读取摘要, [`gitDiffContext`](../../apps/desktop/src/chat/session/gitDiffContext.tsx) 使用 `@pierre/diffs` 解析工作区补丁, 供标题栏显示变更统计和审查面板展示. 路由也提供分支列表与比较查询.

Git 需要位于 Server 进程的 `PATH` 中. [`gitProcess.ts`](./gitProcess.ts) 直接启动 Git, 禁用已配置的 hook 和 fsmonitor, 跳过可选锁, 并禁用终端凭据提问. 写入需要的锁仍然生效. 审查 diff 查询还会禁用外部 diff, 文本转换和已配置的 clean/process 过滤程序.

在仓库根目录执行:

```sh
pnpm --filter @ema-agent/git test
pnpm --filter @ema-agent/git typecheck
```

测试在临时仓库中检查摘要查询, diff 范围, 首次提交前的 SHA-1 和 SHA-256 仓库, 以及基线重置和限制. 进程测试检查命令失败和输出上限. Git 无法启动时跳过集成用例. 源码入口是 [`index.ts`](./index.ts), 查询实现位于 [`summary.ts`](./summary.ts), [`refs.ts`](./refs.ts)和 [`diff.ts`](./diff.ts), 基线实现位于 [`baseline.ts`](./baseline.ts).
