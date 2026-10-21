# WebSearch 返回无关结果

[English](../en/webSearchResults.md)

## 状态与范围

排查开始于 2026-10-19, 更新于 2026-10-21. 用户报告仅重启 Ema, 没有其他修改, 搜索结果便恢复, 但之后对照测试再次观察到错误相关性. 2026-10-21 将 Bing 搜索入口固定到 `cn.bing.com`, 并移除 `setmkt=en-US`; 这改善了部分查询, 但没有解决全部相关性问题. 根因仍未确认. 本地源码经过独立测试, 但不能据此确认安装版实际使用的准确源码版本或服务来源.

用户报告一次显示成功的 WebSearch 调用, 游戏相关查询却返回 Outlook 教程. 本次排查发出了公共搜索请求, 但没有启动 Ema, 调用付费模型, 读取用户数据库或修改已保存的服务凭据. 后续临时测试文件和源码探针均已删除; 3 个加入过探针的业务文件与加探针前的 SHA-256 完全一致. 重启安装版和提供截图由用户完成.

## 对照与复现

对话原生网页搜索对同一查询返回了相关页面, 包括一篇 [CG 合集攻略](https://www.bilibili.com/read/cv42390779). 这只作为相关性对照, 不代表原生搜索与 Ema 使用同一个服务来源, 网络路径或 HTML 接口.

当前[服务选择](../../../../../src/builtin-tools/tools/WebSearchTool/adapters/index.ts)在支持的 Brave API Key 环境变量存在时使用 Brave, 否则使用 Bing HTML. 它不会轮换服务或合并结果. 未检查安装版进程环境.

复现直接调用真实 [Bing 适配器](../../../../../src/builtin-tools/tools/WebSearchTool/adapters/bing.ts), 不经过 Agent, Tool 调度器, UI 或其他并发操作. 在仓库根目录通过 PowerShell, 现有依赖和 Node.js 24.13.0 执行:

```powershell
@'
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && specifier.endsWith('.js')) return nextResolve(specifier.slice(0, -3) + '.ts', context);
    throw error;
  }
} });
const { bingSearch } = await import('./src/builtin-tools/tools/WebSearchTool/adapters/bing.ts');
const results = await bingSearch('魔法少女的魔女审判 樱羽艾玛 二阶堂希罗 CG 白发 粉发 笑 天空', { signal: AbortSignal.timeout(35000) });
console.log(JSON.stringify(results.map(item => ({ title: item.title, url: item.url })), null, 2));
const related = results.filter(item => /魔女|樱羽|櫻羽|艾玛|艾瑪|希罗|希羅|majo|witch|sakuraba|nikaido/i.test(item.title + ' ' + item.snippet));
console.log('Repeat fixture topic hits:', related.length);
assert.ok(related.length > 0, 'REPRO: no result mentions this game or its characters');
'@ | node --experimental-transform-types --input-type=module -
```

导入钩子只在独立进程中将源码相对 `.js` 导入解析为 `.ts`, 不修改文件. 更早使用 `tsx` 的尝试在发出搜索请求前因 `spawn EPERM` 失败; 原生 Node TypeScript 加载器避开了该子进程需求.

断言仅针对这组复现查询, 不是准备加入生产代码的相关性过滤器. 两次直接适配器调用各返回 10 条结果, 主题命中数都为 0. 第一次包含泛化的 Bilibili 首页, 下载页和其他入口页; 第二次包含 BB30-2K-K 轴承. 上述重复命令以以下结果结束:

```text
Repeat fixture topic hits: 0
AssertionError [ERR_ASSERTION]: REPRO: no result mentions this game or its characters
exit code: 1
```

不同请求中的无关主题发生变化. 这是实时网络复现, 不是确定性测试数据; 两次失败说明观察到问题重复出现, 不代表固定失败率.

## 响应边界检查

复现后进一步区分三种可能: 获取到的 HTML 已经包含无关结果, 解析器选取了不同页面区域, 或请求的地区/查询条件影响结果. 响应仅在内存中复制和检查, 没有保存 HTML 或修改应用文件.

| 请求 | 响应观察 | 解析结果 |
| --- | --- | --- |
| 原查询和原适配器请求不变 | HTTP 200, 从 www.bing.com 跳转至 cn.bing.com; 请求查询, 最终 URL 查询, 页面标题和搜索框值均保留输入查询 | 10 条 Qwen 相关结果, 与 HTML 搜索结果标题一致 |
| 仅将 setmkt 从 en-US 改为 zh-CN | URL, 标题和搜索框仍包含正确查询 | 9 条微信公众号结果, 与 HTML 搜索结果标题一致 |
| 仅将查询缩短为游戏名和艾玛名字 | URL, 标题和搜索框仍包含正确的缩短查询 | 10 条自旋轨道转矩结果, 与 HTML 搜索结果标题一致 |

三次检查中, `ol#b_results li.b_algo` 与解析器选择的 `li.b_algo` 数量相同, 搜索结果容器内读取的标题也与适配器输出一致. 这些响应收到时就已包含无关条目, 并非解析时误选无关侧栏引入.

## 后续直接请求与源码探针检查

使用原生 fetch 直接请求用户给出的准确 `cn.bing.com/search?q=...` URL, 不添加自定义请求头且不自动跟随跳转, 连续 3 次返回 HTTP 200 和相同的相关结果标题. 后续对 CN 地址分别添加原地区参数, 原请求头或两者, 也都返回相关结果. 对原 www 地址的手动请求返回 HTTP 302, Location 为预期的 CN 地址.

临时探针随后跟踪 Tool 输入, 服务选择, 真实网络请求与跳转响应, 响应正文, 编码与解析, 过滤, 以及提供给模型的输出. 测试执行 `WebSearchTool.execute` 和 `mapResultToModelContent`, 不经过运行中的安装版 Server, Agent 调度器或聊天 UI. 为选择 Bing 且不调用带 Key 的 API, 仅在独立测试进程中清空 Brave 凭据变量; 没有修改应用配置.

| 源码测试 | 搜索调用次数 | 观察结果 |
| --- | ---: | --- |
| 原 WebSearch 请求, 保留原请求头, 参数和自动跳转 | 12 | 全部返回 10 条相关结果, 查询和提供给模型的链接均保留 |
| 相同请求直接发送至 cn.bing.com | 3 | 全部返回 10 条相关结果, 查询和提供给模型的链接均保留 |
| 原请求按 Location 手动逐跳跟随 | 3 | 全部返回 10 条相关结果, 查询和提供给模型的链接均保留 |
| 关闭源码探针后的独立 Bing 适配器调用 | 3 | 全部返回 10 条相关结果 |

10 次重复调用所用临时命令为 `node --experimental-transform-types src/builtin-tools/tests/webSearchProbe.mjs original 10`. 每次摘要均为 `count: 10`, `topicHits: 10`, `queryPreserved: true`, `modelLinksPreserved: true`, 退出码为 0. 最初 original 模式运行另有 2 次调用. 临时文件已不存在, 此命令仅作为实际执行过的测试记录保留.

未修改的请求仍经过 `www.bing.com -> 302 -> cn.bing.com -> 200`, 两跳查询均保留. 常规 buffer 解析与显式 UTF-8 解码检查得到的正文结果标题一致, 解析结果经过过滤和模型输出后也保持一致. 后续这批运行没有复现早先的无关结果, 因此不能认定自动跳转就是原因.

## 固定 cn 搜索入口后的实测

此前对照使用的查询是 `"chocolate wafers" trans fatty acid Turkey 2007 study`. 预期结果应是土耳其巧克力或威化饼干反式脂肪酸研究, 尤其是论文 `Trans fatty acid contents in chocolates and chocolate wafers in Turkey`. 通过代理请求 `www.bing.com` 时, 实际结果却是 Canon 的纸艺玩具和场景页面, 与查询主题无关; 同一查询直接到 `cn.bing.com` 时出现了土耳其脂肪酸研究和目标论文. 因此适配器入口改为 `https://cn.bing.com/search?q=...`, 不再让 `www` 入口按请求路径跳转, 也不附加 `setmkt=en-US`. 请求头, 自动跟随跳转和页面解析逻辑均未修改.

2026-10-21 使用生产 Bing 适配器, 通过显式配置的本机 Clash HTTP 代理 `127.0.0.1:7890`, 对四条查询各请求一次, 不重试, 不使用浏览器 Cookie. 所有响应都是 HTTP 200 且解析成功:

| 查询 | 观察结果 |
| --- | --- |
| 论文完整标题 | 结果与目标论文相关 |
| `"chocolate wafers" trans fatty acid Turkey 2007 study` | 预期找到土耳其脂肪酸研究; 实际前列包含土耳其研究和目标论文, 不再是此前代理经 `www` 返回的 Canon 纸艺玩具/场景页面 |
| `"Studies of Flavonoids and Cardiovascular Outcomes" table` | 仍返回 studies 词典及泛化页面, 与目标主题无关 |
| `Python official tutorial lists` | 返回 Python.org 文档等相关页面 |

先前测试曾保留 `setmkt=en-US`. 去掉该参数后, 四条查询的结果相关性模式没有变化. 这说明这组观察中移除该参数没有改变结果, 但不能推出 Bing 的所有地区和查询都不受市场参数影响. 完整 HTTP 响应与逐条结果保存在本机忽略目录 `docs/testing/handoffs/webSearchProxyComparison20261021/results/final-cn-endpoint/2026-10-21T06-12-05-508Z-53236/`.

本次支持的结论是: 对上述具体查询, 固定 CN 入口后结果从无关的 Canon 纸艺玩具/场景页面变为相关的土耳其脂肪酸研究; 但 Flavonoids 查询仍然无关. HTTP 成功和解析成功不代表结果相关. 证据仍不能确定此前异常由代理, Bing 上游排序, 地区选择或其他请求条件中的哪一项单独导致. 代码旁保留 TODO, 后续再完善 Bing 地区选择策略.

## 安装版恢复反馈

2026-10-20, 用户确认只重启 Ema, 没有其他改动, 随后同一查询返回相关游戏和角色结果. 用户没有报告修改代理或环境变量. 用户提供的截图显示, 历史仍有一次 Outlook 结果, 新搜索则显示相关条目.

后续一次 WebFetch 失败, 另一次成功. 它们获取的是单个结果页面, 不能据此认定新的 WebSearch 失败. 未检查该 WebFetch 的错误详情. 结果列表相关, 也不代表已经找到指定 CG, 或回答中的每个陈述都已核实.

观察顺序是先重启, 后恢复; 证据没有说明哪项进程状态, 网络条件或其他因素发生变化. 后续成功的独立源码测试与安装版重启反馈是分别记录的观察, 不是受控的修改前后对照实验.

## 可支持的结论与停止点

早期独立测试在没有 Tool 调度或并发 Agent 的情况下返回无关结果. 后续同一源码路径返回相关结果, 用户也报告安装版重启后恢复. 两组观察均保留. 页面中的查询文字正确, 不代表搜索结果正确. 适配器会检查状态码, 页面结构和验证挑战标记, 但早先无关响应通过了这些检查.

这些证据不能确定异常 HTML 来自上游搜索服务, 中间网络组件还是其他请求条件. 也不能证明安装版最初 Outlook 结果的原因完全相同, 或所有其他场景的调度都正确. 初期改变地区/查询没有解决当时故障, 后期不改源码请求却成功. 两阶段都没有确认一项有效修复.

删除 Brave 只保留 Bing 不是已证明的修复. 没有删除或禁用服务, 也没有放宽网络权限. 当前状态为部分缓解, 原因未确认. 直接适配器测试通过工作区 TypeScript 编译器构建后执行; `pnpm` 包装命令启动 Node 时返回 `EPERM`, 因而未使用该包装命令. 没有运行包级测试套件或重新构建安装包, 也没有验证安装版是否包含此次源码更改. 用户仍需在发布版中验证实际行为.
