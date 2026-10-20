# Narrative

[English](./README.md)

本包检索魔法少女的魔女审判固定三周目的原文. 一次 LLM 调用判断用户问题可能涉及哪些周目, 只为这些周目生成子问题并提取关键词; 检索找到来源原文后, Rerank 按原问题排序. 返回的是主 Agent 使用的证据, 不是生成好的回答.

## 使用

宿主打开剧情数据库并创建 Storage Repo, 然后传入三个模型调用函数:

```ts
const search = new NarrativeSearch(chunksRepo, graphRepo);
const result = await search.search(
  query, 'hybrid', completeLLM, callEmbed, callRerank, signal,
);
for (const [timeline, value] of result) {
  if ('text' in value) {
    useEvidence(timeline, value.text);
  } else {
    showFailure(timeline, value.message);
  }
}
```

三个调用函数都必传. 结果按路由顺序放在 Map 中, 只包含选中的 1st_Loop, 2nd_Loop, 3rd_Loop. 成功值包含 text, 空字符串表示没有可用证据; 单周目失败值包含 message.

Embedding 必须使用资产原有的 Pro/BAAI/bge-m3 向量空间. 包内检查 1024 维, 但其他 1024 维模型不能直接替换. 存储向量为小端 Float32. 模型配置和用量记录由宿主处理.

## 查询流程

英文 README 的时序图对应以下顺序: 路由和提词, 去重并批量编码, 按周目读取图与来源原文, 分别重排, 按路由顺序返回证据或单周目错误.

路由优先遵守用户明确指定的周目. 没有限定较早阶段而只问最终结果时查第三周目, 要求跨周目比较时才扩大范围. 固定摘要帮助定位事件和补全姓名, 不作为证据返回, 不把答案预填进子问题.

高层关键词用于主题和关系, 低层关键词用于具体人物和对象. 主题短语使用英文, 专名保留问题语言. 两组都允许为空. 所有周目需要编码的文本先去重, 再合成一次 Embedding 请求.

| 模式 | 查询方式 |
| --- | --- |
| local | 低层关键词查实体, 再读相邻关系 |
| global | 高层关键词查关系, 再读两端实体 |
| hybrid | 交替合并 local 和 global, 按身份去重 |
| naive | 用子问题向量直接搜索原文块 |
| mix | hybrid 加直接原文块搜索 |

local 或 global 缺少本侧关键词时可以使用另一侧. 两类都为空时, local, global, hybrid 和 mix 返回空背景, naive 仍查询原文.

实体和关系各从最多 40 个向量候选开始. 它们与直接原文搜索都使用余弦相似度, 门槛为 0.2. 图已经限定来源范围的原文块只排名, 不再使用该门槛. 先限制实体和关系描述的长度, 再读取来源块; 图描述本身不随原文返回.

来源块按实体或关系分组, 去掉重复引用后用子问题向量排名. 先选实体来源块, 关系侧排除这些已选块. 没有可用来源向量时按组顺序分配份额, 靠前的组较多. 分配数量使用 Python 的舍入规则, 保持 LightRAG 的算法行为.

每周目最多把 20 块完整原文交给 Rerank, query 是原始 search 问题, 不是关键词. 每周目最多保留 8 块, 不比较不同周目请求的分数.

## 预算, 失败和取消

整次查询预算为 32,000 个 UTF-16 码元, 按选中周目数均分, JSON 转义与换行也计入. 按重排顺序保留完整前缀块, 遇到放不下的块就停止, 不截断正文. 每行是带 chunk_id 和 content 的 JSON 对象, 周目由 Map 键确定.

空问题, 路由请求失败, 无效规划或未知周目导致整次查询抛错. 路由解析会去掉思考标签并尝试修复 JSON 格式, 但字段仍须通过 Schema 校验, 失败后不临时编造关键词.

批量 Embedding 失败时, 需要向量的周目分别返回失败原因. 某周目本地检索或 Rerank 失败不影响其他周目, 也不把未重排的结果当成成功结果返回. 没有候选原文时不调用 Rerank.

同一个 signal 传入全部模型调用. 取消直接抛给调用方, 不记录成周目错误. 每个周目开始本地检索前让出一次事件循环, 重排请求可以同时等待. SQLite 和向量计算仍在同一线程, 没有 Worker, 同步计算期间不能处理新到达的取消事件.

## 宿主接入与数据

`apps/server/src/composition/narrative.ts` 在 Turn 准备时解析 narrative-llm, narrative-embed, narrative-rerank 绑定. 每次模型调用记录最终用量, 归属发起查询的 Session 和 Turn. 配置变化影响下一 Turn. 查询模式设置为 auto 时使用工具传入模式或 hybrid, 固定设置则覆盖工具选择.

路由和提词使用原生非流式 LLM 完成接口, 固定传入 `maxOutputTokens: 8192`, 不直接采用目录中的模型最大输出容量. 这是请求预算, 与上面的证据文本预算不同. 输出达到上限时让路由失败, 不继续解析截断结果. Anthropic SDK 可能在发送 HTTP 前拒绝过大的非流式输出预算; 当前接线不需要因此增大超时或改成流式.

Turn 准备先用 `isWitchTrialCharacter` 检查当前角色完整姓名, 名单命中且模型配置可用时才提供查询函数. 名字匹配支持固定的中日英完整姓名, 去掉首尾空白并忽略英文大小写, 不改用户工具开关. 浏览器使用单独的 `@ema-agent/narrative/isWitchTrialCharacter` 入口, 避免加载 Node 检索代码.

该入口还导出 `witchTrialCharacterNames`, 与判定函数共用同一份分组姓名. 每组第一项是中文全名, 后面是其他可识别的完整姓名. 角色设置表格直接渲染这些分组, 不另外维护一份名单.

`NarrativeSearchTool` 把 Map 转为可持久化和传输的数组, 根据正文和失败情况计算 found/partial/empty/unavailable, 再把证据及失败文字交给模型和 UI.

固定正文, 实体, 关系, 来源映射和向量由 Storage 读取. 图模式只读候选来源向量, naive 和 mix 读取本周目的全部正文向量. mix 的来源选块复用该次读取. 合并候选 ID 后再读正文, 查询结束后不保留向量或中间结果.

## 阅读与验证

完整流程看 `pipeline/recall.ts`, 路由看 `router.ts` 和 `prompts.ts`, 模式选择看 `query.ts`, 来源选块看 `retrieval/sourceChunks.ts`. 向量排名在 `vectors.ts`, 完整块预算在 `context.ts`.

运行 `pnpm --filter @ema-agent/narrative test` 和 `pnpm --filter @ema-agent/narrative typecheck`. 测试使用真实内存 SQLite 表和 Repo, 模拟模型响应, 覆盖路由调用次数, 编码去重, 五种模式, 重排输入和顺序, 预算, 部分失败与取消. 工具转换测试在 `src/builtin-tools/tests/NarrativeSearchTool.test.ts`. 这些测试不验证真实模型的路由效果或固定摘要的剧情准确性.

查询算法和关键词分类参考 LightRAG 1.4.16, MIT 许可证保存在 [LICENSE.lightrag](./LICENSE.lightrag).
