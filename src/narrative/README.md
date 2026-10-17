# Narrative


手动真实模型验收入口是 `apps/server/src/composition/tests/narrativeSmoke.ts`. 在仓库根目录运行 `node --import tsx apps/server/src/composition/tests/narrativeSmoke.ts <已启用的 Rerank 模型 ID>`. 它读取当前配置, 在内存副本中绑定指定重排模型, 调用正式 Server 查询函数, 核对单周目结局证据、跨周目结果及 SQL 计量. 另用当前艾玛人设生成一次回答. 运行会产生模型费用, 不更改用户绑定或会话; 不替代原会话中主 Agent 多轮工具调用的验收.
查询固定的三周目剧情资产. 一次 LLM 调用确定周目、子问题和关键词, 用 LightRAG 的实体、关系及文本块算法召回原文, 再按原问题重排. 返回证据, 最终回答由主 Agent 生成.

## 使用

宿主打开剧情数据库, 创建两个 Storage Repo, 并传入已有的三个模型调用类型:

```ts
import { NarrativeSearch } from '@ema-agent/narrative';

const narrative = new NarrativeSearch(chunksRepo, graphRepo);
const result = await narrative.search(
  query,
  'hybrid',
  completeLLM,
  callEmbed,
  callRerank,
  signal,
);

for (const [timeline, value] of result) {
  if ('text' in value) {
    useContext(timeline, value.text);
  } else {
    showFailure(timeline, value.code, value.message);
  }
}
```

三个调用函数均必传. 结果是 `Map<NarrativeTimelineId, NarrativeTimelineResult>`, 只包含路由选中的周目, 顺序与路由结果一致. 每个周目返回 `{ text }` 或 `{ code: 'timeline_query_failed', message }`. 空文本表示没有可返回的证据.

`CallEmbed` 必须使用资产原有的 `Pro/BAAI/bge-m3` 向量空间, 包内检查返回维度为 1024. 同样是 1024 维的其他模型不能直接与这些向量比较. 模型绑定、协议参数及用量记录由宿主负责, Narrative 不接收 Session、Turn 或供应商身份.

Server 使用 `narrative-llm`、`narrative-embed`、`narrative-rerank` 三项绑定. 在 Turn 准备时解析并固定本轮配置, 后续设置变更影响下一 Turn. Server 的 `complete`、`completeEmbed`、`completeRerank` 分别传入对应的 Call 参数.

Server 通过 `createLLMCompletion(connection, modelId)` 创建最终结果函数. 每次路由等待非流式请求完成, 读取最终用量后记一条记录, 直接将 completion 交给 Narrative 解析. 请求失败且没有完整结果时, Token 字段留空. Embedding 和 Rerank 在请求结束后各记一次. 记录使用本次真实调用的唯一 ID, 并归属发起查询的 Session 和 Turn. Narrative 本身不记账.

## 查询流程

```text
问题
  → 一次 LLM 根据剧情摘要生成周目、子问题和两类关键词
  → 合并并去重编码文本, 一次批量 Embedding
  → 各周目按所选算法召回实体、关系及来源原文
  → 每周目最多二十块候选, 分别调用 Rerank
  → 每周目最多八块重排后的原文, 分配整次查询的字符预算
  → 按路由顺序返回各周目证据
```

路由优先遵守用户指定的周目. 未限定较早阶段而只问最终结果时, 查询第三周目; 明确跨周目比较时才扩大范围. Summary 只帮助确定范围和消除姓名歧义, 不代替证据或把答案预填进子问题.

高层关键词表示主题和事件, 用于查关系; 低层关键词表示具体人物及对象, 用于查实体. 主题短语使用英文, 专名保持原语言, 可按摘要补全确定的中文全名. 两组关键词可以为空, 不为填满字段编造内容. 规划结果每次生成, 不读写关键词缓存.

| 模式 | 查找方式 |
| --- | --- |
| `local` | 具体人物等关键词搜索实体, 再读取相邻关系 |
| `global` | 主题、事件等关键词搜索关系, 再读取两端实体 |
| `hybrid` | 交替合并 local 与 global, 去掉重复项 |
| `naive` | 子问题直接搜索文本块, 不消费图关键词 |
| `mix` | hybrid 加子问题的直接块搜索 |

local 或 global 缺少本侧关键词时, 使用另一侧召回. 两类关键词都为空时, 当前图模式和 mix 返回空背景, naive 仍用子问题查询正文. 规划 JSON 无效时整次失败, 不使用临时关键词补救.

实体、关系及直接文本块搜索采用余弦相似度, 门槛为 0.2. 图已经确定的来源块只在候选组内比较相似度, 不再套用门槛. 实体和关系的初始向量候选各最多 40 条; 来源正文合并去重后取前 20 块进入重排.

Rerank 的 query 是传入 search 的完整问题, documents 是未截断的原文块. 不用关键词替代问题, 不比较不同周目请求的分数. 每个周目独立保留相关证据.

整次查询的证据预算为 32000 个 JavaScript 字符, 按选中周目数均分. JSON 转义和条目间换行也计入预算. 每周目按重排顺序保留完整前缀块, 第一块超出剩余预算就停止, 不切断块内正文. 图中的实体描述与关系描述只用于确定来源, 不随原文重复返回. 每行原文包含资产的 `chunk_id` 与 `content`, 周目归属由 Map 的键确定.

## 数据与调度

固定正文、图及向量由 Storage Repo 读取. 本包不导入新剧情、不修改资产、不执行 SQL. Narrative 数据库首次安装导入三周目资产; 已有 v1 数据库升级到 v2 只删除关键词缓存表, 不重新导入正文或向量.

local/global/hybrid 只读取所需的实体、关系及来源块向量. naive/mix 在本周目的全部文本块中搜索; mix 的来源选块复用这次读取的数据. 正文在候选 ID 合并后批量读取, 查询结束后不持有整库向量.

各周目异步任务独立调度, 重排网络请求可以同时等待. SQL 和向量计算仍在同一线程轮流执行. 每个任务开始计算前让出一次事件循环以响应取消, 同步计算中不能处理新的取消事件.

## 失败与取消

空问题、路由请求失败、规划结果无法解析或包含未知周目时, 整次查询抛错. 批量 Embedding 失败时, 需要它的周目分别返回失败原因. 某周目本地检索或重排失败时, 其他周目仍能成功, 不自动退回未经重排的结果.

`signal` 传入三个模型调用, 各阶段也检查取消. 取消向调用方抛出, 不伪装成周目检索失败. 没有候选正文时不发起 Rerank 请求, 因而不产生该调用的用量记录.

## 角色与桌面配置

Turn 准备时按当前角色姓名调用 `isWitchTrialCharacter`. 它只识别名单中的中、日、英文完整姓名, 去掉首尾空白并忽略英文大小写. 不匹配昵称或描述. 不在名单中的角色不取得 NarrativeSearch, 不修改工具开关.

名单命中后仍需三个可用模型绑定, 且工具未手动禁用. 桌面绑定页提供 Narrative Rerank 项; Chat 提示读取角色、Provider、绑定和工具开关, 配置缺失时可跳转绑定页. 前端只检查配置, 不验证 Key 有效性或网络.

浏览器使用 `@ema-agent/narrative/isWitchTrialCharacter`, 只加载姓名判断, 不加载 Node 检索实现. Agent 通过普通工具调用查询, 结果由 NarrativeSearchTool 将 Map 转成可持久化数组, 复用历史和工具 UI 的传输形式.

## 验证与来源

`pnpm --filter @ema-agent/narrative typecheck` 和 `pnpm --filter @ema-agent/narrative test` 检查查询包. 测试使用真实 SQLite 表及 Repo, 覆盖一次规划、批量编码去重、五种召回模式、重排输入与顺序、多周目预算、部分失败和取消. Server 装配测试核对最终用量、失败记录及 Session/Turn 归属.

查询算法和关键词分类参考 LightRAG 1.4.16. MIT 许可证保存在 [LICENSE.lightrag](./LICENSE.lightrag).
