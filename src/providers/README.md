# @ema-agent/provider

Ema 产品源码中的 Provider 目录与模型事实模块。描述供应商是谁、支持哪些能力、每项能力可用什么协议与模型来源，并统一解析 models.dev 能力快照；**不保存用户密钥明文，不直接发起模型 API 请求**。

目录位于根 `src`，因为供应商能力是 Ema 的产品业务；内部包名 `@ema-agent/provider` 仅用于 TypeScript/Turbo 编译边界，不表示它是可独立发布的公共库。

## 职责边界

**拥有：** 供应商静态定义、能力/协议模型、配置生命周期校验、业务模块→模型绑定、连通性探测编排、models.dev 目录与能力快照。

**不拥有：** 凭据存取（`packages/credential` + `src/storage` 的加密列）、模型调用执行（`src/llm`、`src/embed` 等执行面各自实现协议）、HTTP 装配（`apps/localHost` 的 wiring/routes)、UI 图标资产（`@ema-agent/ui` 按 `iconId` 解析）。

## 文件结构

```text
types.ts               基础类型:Capability、ProtocolFamily(14 种协议)、ProviderDefinition、
                       ProviderModelSource、defineProvider/defineXxxCapability 定义辅助
definition-utils.ts    定义查询函数:能力列表、协议列表、默认地址解析、models.dev/静态模型来源、
                       isXxxProtocol 类型守卫
registry.ts            19 家内置供应商的静态目录(数组顺序即设置页展示顺序,新增时显式选位)
facade.ts              ProviderCatalogFacade:目录只读查询的唯一业务入口,导出单例 providerCatalog
configuration.ts       ProviderConfiguration:配置生命周期(create/update/delete)、能力校验、
                       凭据三态写(保留/清空/替换)、删除/禁用前的绑定冲突保护
modelBindings.ts       ModelBindingControl:业务模块→Provider+模型 绑定;8 个合法模块,
                       lightrag-* 绑定变更后触发 Bridge 配置同步
probe.ts               ProviderProbe:按能力选探测模型(启用池→目录回退)、执行探测、健康落库
errors.ts              ProviderConfigurationError:六个稳定错误码 + 绑定冲突明细
index.ts               公共出口;外部禁止穿透内部文件

catalog/
  modelsDevCatalog.ts  ModelsDevCatalog:models.dev api.json 的解析与内存索引。
                       查询一律走 Provider+Model 精确身份(get/listLlmModelIds/
                       listVisionModelIds/supportsImageInput),不提供裸 modelId 查询
  modelCapabilities.ts ModelCapabilitySnapshot/Resolver:模态、工具、推理、窗口的能力事实;
                       三态语义 supported/unsupported/unknown,未收录时诚实返回 unknown

definitions/           19 家供应商定义。多能力家一个能力一个文件(openai/llm.ts …),
                       单能力家内联(deepseek、ollama)。只声明事实,无行为

tests/                 目录完整性约束(身份唯一、协议匹配能力、静态模型非空)+
                       models.dev 解析与能力解析顺序
```

## 核心概念

**Provider 是控制面。** `ProviderDefinition` 声明身份（`id` 稳定、发布后不可改）、`connection`(默认地址 + 认证方式）、`branding.iconId`（与图标库解耦的 UI 身份）、`capabilities`（每项能力若干 `transports`：协议 + 可选覆盖地址）。

**能力配置是用户面。** 用户覆盖的协议、地址、开关存 `provider_capability_configs` 表；`ProviderCapabilityConfiguration` 的 `protocol`/`baseUrl` 留空 = 用定义首选/默认值；`embeddingRevision` 仅 Embed 使用，区分同名模型的向量空间代际。

**绑定是业务面。** `MODEL_BINDING_MODULES` 八个模块（`memory`、`title`、`lightrag-embed`、`lightrag-llm`、`tts`、`stt`、`vision`、`imagegen`)；业务代码按模块名取绑定，不直接挑 Provider。`MODEL_BINDING_CAPABILITIES` 把模块映射到能力，供禁用保护（`provider_capability_in_use`）使用。`imagegen` 为预留，未开放 UI 与执行链。

**能力查询必须精确身份。** 同名模型在不同 Provider 的能力/窗口可以不同，禁止按裸 `modelId` 跨 Provider 猜测；统一走 `ModelCapabilityResolver.resolve({ providerId, model, modelsDevId? })`。未收录模型返回 `unknown` 三态，调用方自行决定降级，不允许猜。

## 公共接口

| 导出 | 用途 |
|---|---|
| `providerCatalog` (`ProviderCatalogFacade`) | 定义查询：get/list/ids/listByCapability/protocolsOf/defaultBaseUrlFor/modelSourcesOf |
| `ProviderConfiguration` | 配置生命周期；构造注入 `ProviderDefinitionCatalog`、存储、绑定查询、运行时刷新、id 工厂 |
| `ModelBindingControl` | 绑定读写；`lightrag-*` 变更后自动触发 `syncNarrativeBridge()` |
| `ProviderProbe` | 探测编排；模型类能力（llm/embed/rerank/vision）按"指定→已启用→目录首个"选模型，tts/stt 探端点 |
| `ModelsDevCatalog` | models.dev 解析/刷新；`refresh()` 先建候选再整体替换，空目录保留现役快照 |
| `createModelCapabilityResolver` | catalog → 能力快照；支持设置页手工 Vision 声明回退 |
| `validateCapabilityConfigurations` | 能力配置校验（重复、不支持的能力/协议、embeddingRevision 越界） |
| `ProviderConfigurationError` | `unknown_definition` / `invalid_capability_config` / `capability_not_supported` / `not_found` / `provider_capability_in_use` / `provider_in_use` |

## 装配示例（apps/localHost)

```ts
const configuration = new ProviderConfiguration(
  providerCatalog,           // 静态目录
  configurationStore,        // StorageProviderConfigurationStore(Storage 行→业务结构)
  bindings.modelBindings,    // 删除/禁用前的冲突查询
  bindings.providerRuntime,  // refresh():TS 运行时换代 + Bridge 串行同步
  randomUUID,
);

const control = new ModelBindingControl(bindings.modelBindings, bindings.providerRuntime);

const probe = new ProviderProbe(configurationStore, modelSource, executor, healthRecorder);
// executor 按能力分发到 llm/embed/rerank/vision/tts/stt 各 Runtime 的 probe();
// healthRecorder 落库 provider_health(status: ok|failed|unknown、延迟、错误、连续失败数)。
```

凭据纪律：`ConfiguredProvider.credential` 只允许进程内短暂存在；HTTP 投影 `hasApiKey`；查看明文走显式 `revealCredential(id)`（路由侧 `no-store`)。

## 数据流

```text
设置页保存 → ProviderConfiguration.create/update(校验+冲突检查)
           → Storage 持久化(凭据加密列)
           → ProviderRuntimeFacade.refresh()
               ├─ TS 各 Runtime 先建下一代 Adapter Map 再交换引用
               └─ syncBridge():lightrag-* 绑定变化串行推送 Bridge 全量快照

探测 → ProviderProbe.run(能力+模型选择)
     → 执行面 Runtime.probe(超时/取消/终态)
     → recordHealth 落库 → 设置页下次读取展示
```
