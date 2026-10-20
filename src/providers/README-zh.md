# Providers

[English](README.md)

`@ema-agent/providers` 保存模型供应商, 凭据, 协议地址, 模型参数, 以及各业务模块选用的模型. 调用方指定供应商和能力后, 本包解析出 API 包可以使用的连接.

## 使用连接

宿主提供已经完成迁移的 `@ema-agent/storage` profile `Database`.

```ts
import { Providers } from '@ema-agent/providers';

const providers = new Providers(profileDb);
providers.create({
  id: 'local-models',
  name: 'Local models',
  authType: 'none',
  capability: {
    capability: 'embed',
    protocol: 'openai-embed',
    baseUrl: 'http://127.0.0.1:8080/v1',
  },
});

const connection = providers.resolveConnection('local-models', 'embed');
// { providerId, protocol, baseUrl, apiKey? }
```

调用方把连接和模型 ID 交给 `createEmbedCall`, `createRerankCall`, `createTTSCall`, `createSTTCall` 或 LLM/Vision 的入口. 各能力分别选择协议和地址, 同一供应商的能力共用一份凭据.

浏览器代码从 `@ema-agent/providers/types` 导入运行时常量. 这个入口对 Storage 只有类型依赖. 主入口会构造数据库 Repo, 用于 Server.

## 保存的数据与公开操作

| 入口 | 操作 | 保存的数据 |
| --- | --- | --- |
| `Providers` | 创建, 修改, 删除, 列出供应商, 解析连接, 保存探活结果 | `providers`, `provider_capabilities`, `provider_protocols`, `provider_health` |
| `ProviderModels` | 保存手填模型, 启停, 删除, 同步目录 | `provider_models` |
| `ModelBindings` | 设置, 读取, 列出, 删除业务模块选用的模型 | `model_bindings` |
| `ModelsDevCatalog` | 解析目录, 按供应商和模型查询条目 | 从 JSON 文件读取的内存目录 |

Storage Repo 读写 `profile.db`. 内置供应商由 Storage 迁移插入, 后续与自建供应商使用相同操作. 凭据以明文保存. Server 的供应商列表返回 `hasKey`, 详情返回完整的 `keyValue` 供编辑.

模型通过 `(providerId, capability, modelId)` 确定. LLM 与 Vision 保存上下文窗口及能力参数, Embedding 保存维度, Rerank 保存可选的 `maxChunks`. 已保存模型中, 未知的可选能力保持 `null`, 不当作 `false`.

`create()` 一次配置一个能力. ID 已存在时追加缺少的能力, 并可更新共享凭据; 供应商原有名称与认证方式保持不变. 同一 ID 和能力不能重复创建. 新建能力必须明确填写协议和 `baseUrl`.

`activeProtocol` 为 undefined 表示能力停用, 已配置协议保留. 删除当前协议后切换到剩余第一项, 不能删除全部协议. 更新时 `key: undefined` 保留凭据, `key: null` 清空凭据.

`resolveConnection()` 要求有选中的协议及地址, `bearer` 认证还要求凭据. 返回的是配置, 不表示网络测试已经成功.

Provider 的 `id`, 显示名称 `name`, 能力的 `modelsDevId` 含义不同. ID 用于保存引用, 名称用于界面显示, `modelsDevId` 用于选择外部目录. 内置国内站使用 `siliconflow-cn` / `SiliconFlow-CN` 和 `moonshotai-cn` / `Moonshot Kimi-CN`, 目录 ID 与 Provider ID 一致. 图标键仍为 `siliconflow` 和 `moonshot`. 这些预置由 Storage 初始化直接写入.

DeepSeek 同时提供 LLM 和 Vision 能力, 目录关联为 `deepseek`. 两者默认使用 Chat Completions, 同时配置 Anthropic 兼容地址. Vision 从目录中只导入支持图片输入的模型, 初始化不选择, 启用或绑定具体模型.

LLM 和 Vision 创建时接受可选的 `modelsDevId`. 更新时省略表示保留, 传 `null` 表示清空. 清空或更换关联不删除已有模型和绑定, 也不更换 API 地址. 没有关联时手动添加模型.

## 模型与绑定

手填模型的 `source` 为 `'user'`, 首次保存时启用. 再次保存会更新参数, 保留启用状态. 目录模型的 `source` 为 `'dev'`, 参数通过目录同步更新. 两种模型都可启停和删除.

`ModelBindings.set()` 根据业务模块名确定能力, 只接受该能力下已启用的模型. Server 的绑定路由还会在保存前解析连接. `/available/:capability` 路由列出连接可解析的已启用模型.

删除供应商, 停用能力, 停用或删除模型前, 会检查已保存的业务模块绑定. 存在冲突时抛出带 `conflicts` 的 `ProviderError`, 设置页据此提示先换绑或解绑. 这里检查的是业务模块绑定, 不是 Session 的模型选择.

探活结果按 `(providerId, capability)` 分别保存. Server 执行网络测试, 再把结果交给 `recordHealth()`.

修改共享凭据, 认证方式, 当前协议或当前地址时, 在保存配置的同一事务中清除受影响的旧探活结果. 修改显示名称或目录关联不会使连接结果失效.

未显式指定模型时, Server Ping 按列表顺序取第一个启用模型; 全部禁用时取第一行. LLM/Vision 模型池为空时可回退到目录第一项, 其他能力需要手动添加模型. Vision Ping 只发文本请求, 成功不代表图片能力或 Vision 绑定已验证.

## 目录刷新与窗口更新

`loadModelsDevCatalog(filePath)` 读取指定缓存文件. 文件不存在或无法读取时返回空目录, 数据库中已保存的模型仍可使用. 目录查询使用 `modelsDevId` 和模型 ID, 因为不同供应商对同名模型的参数描述可能不同.

`refreshModelsDevCatalog(catalog, filePath)` 在 30 秒超时内下载完整目录, 读完后拒绝大于 8 MiB 的响应, 并拒绝解析后没有可用条目的目录. 内容变化时通过临时文件替换缓存, 再更新原有目录对象. 下载, 解析或保存文件失败时保留当前目录.

Server 按以下顺序处理刷新:

```text
设置页请求刷新某供应商的 LLM 或 Vision 模型
  -> Server 共用尚未完成的目录下载
  -> refreshModelsDevCatalog 保存 JSON 并更新共享目录
  -> syncDevModels(providerId, capability) 在一次 SQL 事务中保存该范围
  -> Server 发布 provider_models_changed
  -> Desktop 重新读取模型列表
```

同步时新目录模型默认停用, 已有启用状态保留, 手填模型不改, 缺少有效上下文窗口的条目跳过, 新目录里消失的模型不自动删除. Embedding, Rerank, TTS 和 STT 的模型由用户手填.

未关联目录或目录供应商不存在时, 返回带可读说明的配置错误. 已存在的目录供应商没有符合条件的 Vision 模型时返回空列表, 不报模型不存在. 刷新使用 models.dev, 不调用供应商混合多种能力的 `/models` 接口. Desktop 后台重读时保留已有卡片, 只有首次加载用 loading 替换列表.

SQL 同步失败时撤回该范围的数据库修改. 已保存的目录文件保留, 可供重试使用. 刷新目录不会自动更换已绑定的模型.

Provider 操作本身不发布窗口事件. Server 保存成功后发布对应的 `ProviderEvent`: `provider_config_changed`, `provider_models_changed`, `model_bindings_changed` 或 `provider_health_changed`.

## 阅读与验证

先看 [types.ts](types.ts) 中的能力, 协议名称和 `ProviderConnection`, 再看 [providers.ts](providers.ts), [models.ts](models.ts) 和 [modelBindings.ts](modelBindings.ts) 中的保存操作. [catalog/modelsDevCatalog.ts](catalog/modelsDevCatalog.ts) 处理目录解析与文件刷新. Server 的 [composition/providers.ts](../../apps/server/src/composition/providers.ts) 协调下载, [routes/providers](../../apps/server/src/routes/providers) 处理 HTTP 响应和通知.

```sh
pnpm --filter @ema-agent/providers test
pnpm --filter @ema-agent/server exec vitest run tests/providerCatalogRefresh.test.ts
```

包内测试使用真实的 profile 数据库, 检查绑定冲突, 模型同步和目录解析. Server 测试通过本地测试环境检查刷新请求和通知.
