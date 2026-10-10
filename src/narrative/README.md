# Narrative

查询固定的三周目剧情资产. 包内保留全剧情摘要路由, 使用 LightRAG 的实体、关系和文本块召回流程, 返回检索背景文本. 不导入新文档、不重新分块、不生成最终回答, 不启动 Python 或 HTTP 服务.

## 使用

`NarrativeSearch` 接收 Storage 的三个 Narrative Repo. 宿主负责打开并初始化 `~/.ema-agent/narrative/narrative.db`, 以及按模型绑定创建 `CallLlm` 和 `CallEmbed`.

```ts
import { NarrativeSearch } from '@ema-agent/narrative';

const narrative = new NarrativeSearch(chunksRepo, graphRepo, keywordCacheRepo);
const result = await narrative.search(query, 'mix', callLlm, callEmbed, signal);

for (const [timeline, value] of result) {
  if ('text' in value) {
    // text 为空表示这次查询完成, 但没有找到可返回的剧情背景.
    useContext(timeline, value.text);
  } else {
    showFailure(timeline, value.code, value.message);
  }
}
```

结果是 `Map<NarrativeTimelineId, NarrativeTimelineResult>`, 仅包含路由选中的周目, 顺序与路由结果一致. 每个周目返回 `{ text }` 或 `{ code: 'timeline_query_failed', message }`. 包还导出结果类型及 `NarrativeQueryMode`, 不接收 Session 或 Turn 身份, 不发送宿主事件.

`CallEmbed` 必须使用资产原有的 `Pro/bge-m3` 向量空间. 仅维度相同不代表模型可以互换; 包内检查返回维度是否为 1024. `CallLlm` 负责路由与提词, 其绑定、协议必填参数和调用重试由宿主处理. 例如 Anthropic 协议所需的 `maxOutputTokens` 应由传入的调用函数补齐, 本包不另设输出预算.

## 查询流程

```text
问题
  → 全剧情摘要路由, 得到周目与各自的子问题
  → 按子问题查询提词缓存, 未命中时调用 LLM 提词
  → 合并这次查询需要编码的文本, 一次批量调用 Embedding
  → 在各周目内按所选模式搜索
  → 按字符数限制实体和关系长度, 从图中找到来源块并选块
  → 交替合并、去重, 通过 Repo 批量读取正文
  → 限制正文长度, 返回各周目的检索背景
```

同一个子问题被分到多个周目时, 在这次查询中只提词一次, 相同文本只编码一次. 成功提词后立即写入 SQL 缓存, 不等待召回完成. 路由每次执行; 不缓存路由或最终检索文本.

| 模式 | 查找方式 |
| --- | --- |
| `local` | 用具体人物等关键词搜索实体, 再读取它们相邻的关系 |
| `global` | 用主题、事件等关键词搜索关系, 再读取两端实体 |
| `hybrid` | 交替合并 local 和 global 的实体与关系, 去掉重复项 |
| `naive` | 路由后的子问题直接搜索文本块, 不提取关键词或读取图 |
| `mix` | hybrid 加子问题的直接块搜索 |

local 或 global 缺少本侧关键词时, 使用已有的另一侧关键词召回. 提词结果无法解析或两组都为空时, 少于 50 个 Unicode 字符的子问题临时作为具体关键词使用; 长问题返回空背景. 当前 mix 在这种长问题没有关键词的情况下也不执行直接块搜索, 此行为仍待确认. 临时替代词不写入缓存.

实体、关系和直接块搜索使用余弦相似度, 门槛为 0.2. 图中已经找到的来源块只在这组候选内比较相似度, 不再套用该门槛. local 的相邻关系按两端连接数之和、关系 weight 排序. hybrid 按 local、global 交替合并; mix 的正文按直接块、实体来源块、关系来源块交替合并.

实体和关系各自的初始向量搜索最多取 40 条, 图扩展后可能得到更多节点或边; 正文最多 20 块. 每个周目的返回长度按 JavaScript 字符串的 `.length` 计算: 实体部分最多 18000、关系部分最多 24000、完整检索背景最多 90000. 这三个上限取原生 token 数值的三倍, 但不代表实际 token 数. 不安装 tokenizer 或加载词表, 不为生成最终回答预留 Prompt 长度. 超出限制时保留前面的完整项, 不截断块内正文或改变正文内容; JSON 转义、条目间换行和背景格式也计入返回长度.

## 数据和缓存

所有 SQL 读取与提词缓存写入都由 Storage Repo 完成. 包内不执行 SQL, 不修改固定剧情正文、图和向量. 关键词缓存使用原生 `mode:keywords:args_hash` 作为键, 哈希输入是模式、子问题和 `English` 的直接拼接; 结果保存为两组关键词数组. 不按供应商或模型区分缓存.

向量搜索是一次普通函数调用: 传入配对的 ID 与向量, 计算余弦相似度, 返回 Top-K ID. 直接读取 SQL 返回的 Float32 Buffer, 不复制成整库矩阵, 不改写资产向量. 只保存本次计算的 Top-K ID 和分数, 同分保留输入顺序.

local/global/hybrid 读取本周目所需的实体或关系向量, 图确定来源范围后只按候选 ID 批量读取块向量. naive/mix 需要在本周目全部文本块中搜索, 才读取全部块向量; mix 的来源选块复用这次读取的数据, 不再查一遍 SQL. 正文在最终合并 ID 后批量读取.

`NarrativeSearch` 只持有三个 Repo, 不保存向量或中间结果, 不要求宿主跨 Turn 复用实例. 各周目作为独立异步任务并发调度, 统一等待完成后按路由顺序组装 Map. 每个任务在开始检索前等待事件循环调度, 等待期间可取消; SQL 和向量计算仍在同一个线程轮流执行, 不使用额外线程, 也不能在一次同步检索中途响应新的取消事件. 这不是多核并行计算, 不因此承诺缩短计算耗时. 向量没有跨查询缓存, 与持久化的关键词缓存分开.

返回文本使用 LightRAG 的实体、关系和文本块格式. 固定资产没有文件路径, 因此不生成文件引用编号. 原文中的换行和已有字符保持不变, 不修复旧资产文本或重新编码.

## 失败与取消

单个子问题提词失败或某个周目查询失败时, 该周目返回失败结果, 其他周目仍能返回成功结果. 公共批量 Embedding 失败时, 需要这些向量的周目分别返回失败. 所有周目都失败时仍返回 Map, 不丢掉各自原因.

空问题、路由调用失败、路由无法解析或返回未知周目时, 整次查询抛错. `signal` 传到 LLM 与 Embedding, 各阶段也检查取消; 取消直接抛出, 不伪装成查询失败. 已经完成的提词缓存写入不会因后续查询取消而撤销.

## 验证与来源

`pnpm --filter @ema-agent/narrative typecheck` 和 `pnpm --filter @ema-agent/narrative test` 仅检查本包. 测试使用真实 SQLite 表和 Repo, 模型调用使用可控的返回结果, 覆盖五种模式、来源选块、块向量读取范围、关键词缓存复用而向量每次读取、长度限制、部分失败和取消.

查询算法和提词、上下文 Prompt 来自 LightRAG 1.4.16; 原剧情路由使用固定的全剧情摘要. LightRAG 的 MIT 许可证随包保存在 [LICENSE.lightrag](./LICENSE.lightrag).
