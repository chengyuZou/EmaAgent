# Provider 控制面

Provider 负责模型连接、模型事实和业务绑定，不执行任何模型 API 请求。

## 边界

Provider 拥有：

- 内置供应商预设；
- 用户 Provider 配置；
- capability 级 `protocol/baseUrl/credential` 解析；
- 用户已经启用的模型事实；
- 业务模块使用哪个模型的绑定；
- models.dev 等外部目录建议的纯解析。

Provider 不拥有：

- LLM、Embed、Rerank、Vision、TTS、STT 的网络调用；
- 重试、流式响应、Usage、Turn、Session、Prompt、Context 或 Tool；
- Adapter Runtime Map；
- Probe 网络编排；
- Narrative Bridge 同步。

## 文件

```text
src/providers/
├─ types.ts                 ModelCapability、协议、Provider 预设与 ProviderConnection
├─ registry.ts              19 个内置 Provider 预设目录 + 单预设纯读取函数
├─ configuration.ts         用户配置 CRUD 与连接解析（ProviderConfigs）
├─ models.ts                已启用模型的判别联合与业务入口
├─ modelBindings.ts         每个业务模块唯一的模型绑定
├─ errors.ts                稳定业务错误
├─ catalog/
│  └─ modelsDevCatalog.ts   外部目录的纯解析器
└─ providers/               发行时内置预设，每厂一个目录
```

## 数据结构

三种身份严格分开：`providerId`（内置预设）/ `providerConfigId`（用户配置）/ `modelId`（模型）。

### 预设（`providers/` 目录的内置品牌卡片）

```ts
Provider {
  id                          // 'openai'、'deepseek'…，预设稳定身份
  name, branding.iconId
  connection: {
    defaultBaseUrl?           // 该厂默认地址，单档协议可各自覆盖
    auth                      // { type: 'none' } | { type: 'bearer', required }
  }
  capabilities: {             // 预设声明的能力，键即 ModelCapability
    llm?, embed?, rerank?, vision?, tts?, stt?
    // 每项 = ProviderCapability {
    //   protocols: ProviderProtocolOption[]    // 可选协议档位；baseUrl 仅当该档不走默认地址时填
    //   catalog?: ProviderModelCatalogSource   // 模型建议来源 { modelsDevId?, staticModels?, supportsLiveListing? }
    // }
  }
}
```

### 用户配置（前端称"服务来源"，`provider_configs` 表）

```ts
ProviderConfig {
  id                          // providerConfigId
  providerId: string | null   // 引用的预设；null = 全自定义连接
  displayName, hasCredential, enabled
  capabilities: ProviderCapabilityConfig[]
}

ProviderCapabilityConfig {
  capability
  activeProtocol?             // 当前使用的协议；undefined = 停用（已配协议保留）
  protocols: ProviderCapabilityProtocol[]   // [{ protocol, baseUrl }]，同一能力可记多档
}
```

### 已启用模型（`provider_models` 表，按能力判别联合）

```ts
ProviderModel =                // 共同身份 (providerConfigId, capability, model)
  | LlmProviderModel      // contextWindow 必填；maxOutput/toolCall/reasoning/temperature/inputImage 三态（true/false/null=未知）
  | EmbedProviderModel    // dim 必填——它是 EmbeddingSpace 哈希输入，是事实不是"设置"
  | RerankProviderModel   // maxChunks 可空
  | VisionProviderModel | TtsProviderModel | SttProviderModel   // 仅身份
```

### 业务绑定（`model_bindings` 表，每模块一行）

```ts
ModelBinding { module, capability, providerConfigId, model }
// module：memory / title / lightrag-llm / lightrag-embed / tts / stt / vision
// 主对话模型不走这张表——chat/work 在 Session 层由用户直接挑选各 Provider 已启用的模型
```

## 核心接口

### `ProviderConfigs`

配置可以引用内置预设，也可以令 `providerId` 为 `null`，表示完全由用户填写的连接。每项 capability 都保存明确的协议和地址；数据库不使用“空值代表跟随预设”的隐式语义。

```ts
const connection = configurations.resolveConnection(providerConfigId, 'llm');
// { protocol: LlmProtocol, baseUrl: string, apiKey?: string }

const llm = createLanguageModel(connection);
```

用户可以在同一 capability 内选择任何 Ema 已实现的同族协议，不受品牌预设限制。只有选中的协议恰好存在预设档位时，`baseUrl` 才可以从预设补全；否则必须显式填写。

普通查询只返回 `hasCredential`。明文凭据只在 `revealCredential()` 和 `resolveConnection()` 的短生命周期内出现。

### `ProviderModels`

`ProviderModel` 是按 capability 判别的联合。统一 SQL 表不会把几十个 nullable 字段泄露给业务：

- LLM：`contextWindow` 必填，`maxOutput/toolCall/reasoning/temperature/inputImage` 可为 `null`；
- Embed：`dim` 必填；
- Rerank：`maxChunks` 可为 `null`；
- Vision、TTS、STT：只保存精确模型身份。

模型身份始终是 `(providerConfigId, capability, model)`。`true/false/null` 分别表示明确支持、明确不支持和未知；`null` 不会动态跟随 Catalog。

### `ModelBindings`

每个 `ModelBindingModule` 只绑定一个已经启用、能力匹配的模型。Provider 只保存绑定事实；例如 LightRAG 绑定变化后的 Narrative Bridge 同步由应用组合层显式执行。

## Catalog 与运行时事实

```text
models.dev / 实况列表 / 用户手填
               │
               └─ 启用或编辑模型时预填
                              │
                              ▼
                       provider_models
                              │
                              └─ 后续运行只读数据库事实
```

`ModelsDevCatalog` 不读取文件、不发网络请求、不写数据库。源字段缺失时保留 `undefined`，不把未知伪装成支持或不支持。下载、缓存和文件读取属于应用组合层。

## Storage 映射

`ProvidersRepo`、`ProviderModelsRepo` 和 `ModelBindingsRepo` 实现 Provider 所有的持久化接口。SQL Row 只存在于 Storage 内部：

- `provider_configs.provider_id` 可空；
- `provider_capability_configs` 保存能力行与当前激活协议（`active_protocol`，NULL = 停用）；
- `provider_capability_protocols` 按 `(配置, 能力, 协议)` 保存每一条已配地址——同一能力可记多档协议，切换激活不丢地址；
- `provider_models` 是六类模型的唯一事实表；
- `model_bindings.module` 是主键，并通过复合外键指向精确模型；
- 删除模型会由外键级联删除对应绑定。

开发数据库需要按新基线刷新；没有旧六表兼容读取或迁移 shim。

## 尚未接线的应用职责

LocalHost 将被替换，因此本批没有给旧 Route/Wiring 做过渡适配。新应用组合层必须按以下顺序接线：

```text
读取 ModelBinding
  → 读取 ProviderModel
  → resolveConnection(providerConfigId, capability)
  → createXxx(connection)
  → 执行单次 API 调用
```

Probe 同样由应用组合层创建真实执行对象并发起真实请求，最后只把健康结果交给 `ProviderConfigs.recordHealth()`。不得在 Provider 内恢复 Probe Executor 或 Runtime Map。
