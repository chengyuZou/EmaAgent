# Providers

`src/providers` 是模型供应商的产品控制面：管理 `providers` 行（内置种子与自建同表同构）、一个 Provider 一把 key、模型池与业务绑定，并把能力配置解析为六个 API 包（llm/embed/rerank/vision/tts/stt）可直接消费的 `ProviderConnection`。

本包不拥有：六个执行面的网络调用与协议 Adapter、重试/流式/Usage、Turn/Session/Prompt/Tool、Probe 执行器（Probe 由组合层发起真实请求，只把结果交给 `recordHealth()`）。

---

## 一、为什么这么设计

### 1. 一切皆是行：内置供应商种子入库，没有"预设"概念

**否决的方案**：代码常量预设（19 个模板文件）+ 用户配置行，前端把两份清单按 id 合并渲染。

否决理由与最终选择的权衡：

- 双源合并意味着每张卡片、每个详情页都要回答"这个字段来自代码还是来自行"。字段所有权一旦有两个候选来源，就一定会长出合并规则、优先级规则和它们的 bug。
- 代码预设的真正好处是"模板演进零成本"（加协议档发版即生效）。但这个好处可以用**迁移纪律**换到：演进只追加 `INSERT OR IGNORE` 迁移，且协议/模型演进带 `WHERE EXISTS` 父行——既尊重用户删除，又永不 UPDATE/DELETE 用户行。成本是每次演进多一个小迁移文件，换来的是**单一事实源**。
- 种子方案还有一个预设方案给不了的简化：**内置 19 个的配置动作是 update 不是 create**。种子行已在库里，点卡片就是编辑（填 key、启用），不存在"创建模式/编辑模式"双态；`create()` 只服务自建 provider，且创建动作按能力分区发起（LLM 区的 + 只建 llm 能力）——没有全局多能力创建入口；id 是用户显式给定的语义 slug（主键，创建后不可改）。

**删除语义**：种子靠 `user_version` 保证只跑一次（不是每次启动重放），删了不会复活。唯一复活路径是迁移链再压缩（re-squash），属发布级操作，届时需附带处理（墓碑或公告）。

**演进规则**（写死，见 `002_provider_seeds.sql` 头注释）：只增不删；新内容一律新迁移文件；`INSERT OR IGNORE`；协议与模型演进必须 `WHERE EXISTS` 父行；永不 UPDATE/DELETE 用户行。

### 2. 连接事实进 SQL，纯展示建议留代码/缓存

划界标准：**运行期要读、用户可能改**的事实进 SQL；**只读展示、无用户态**的建议不进 SQL。

- 进 SQL：协议档与 URL（用户改代理地址）、key、池内模型行、健康、绑定。
- 不进 SQL：协议词汇（14 个写死协议，`isProtocolForCapability` 把关）、models.dev 参数目录。
- **models.dev 目录 = 本地快照 + fetch 刷新**：`catalog/models-dev.json` 是 api.json 的本地缓存（gitignored，拉取产物不入库）；`getModelsDevCatalog()` 惰性读盘一次（缺失/损坏返回空目录，不阻塞主链路），`refreshModelsDevCatalog()` 原生 fetch 拉取、内容有变才覆写快照并重载内存。
- **模型不种子**：`provider_models` 行 = 启用集合的载体，全部从 SQL 读取；llm/vision 由 models.dev 目录同步落库（新增默认禁用 `enabled=0`、`source='dev'`），embed/rerank/tts/stt 只能手写（`source='user'`）。目录只是内部拉取来源（快照缓存 + 拉取函数），不公开端点也不直接进表。

### 3. 模型池：手写与目录同步同表，启停开关是唯一准入

- 行 = 模型池事实。`source='user'` 手写行允许编辑/启停/删除；`source='dev'` 目录同步行禁修改参数、允许启停/删除，刷新时除 `enabled` 外参数以目录为准。
- `enabled=1` 是绑定、`/available` 与探活的唯一准入；停用/删除仍被业务模块绑定的模型抛 `model_in_use`（带 conflicts，前端弹窗引导解绑）。
- 手写与目录同 id：手写行不被目录覆盖（用户事实优先）；dev 行在则手写禁改（参数由目录维护）。
- **允许修改单个模型的参数**：`ProviderModels.save()` 是 upsert（仅 user 行），同主键再保存即更新参数。

### 3. 一个 Provider 一把 key（bearer 才有）

- key 挂在 `providers.key_value` 单值列：一个供应商账号一把 key，全能力共用。bearer 无 key 时先建行、配置动作补；`authType='none'` 的本地 Provider（Ollama 等）无 key 概念。
- 否决"按能力多 key"：能力间 key 隔离当年是给"硅基 LLM 的 key 带到 TTS"打的补丁；单 key 后 TTS 配置天然用同一把，`provider_keys` 表、`active_key_id` 指针与预填/增删选动词全删，换 key = 一次 `UPDATE providers.key_value`。
- **V1 明文入库**：本地单人应用，加密后续由用户本人接线（repo 读写两点就是纯字符串）。**掩码不是后端职责**：`keyValue` 返回全文，"取头尾拼接"与 👁 显示全文都是前端渲染规则，没有 reveal 端点。

### 4. 健康按能力记录、读取内嵌、写读分离

- `provider_health` 按 `(provider_id, capability)` 一行：详情页本来就是 (provider, capability) 作用域，probe 也按能力分端点（probeLlm/probeTts/…），一 provider 一行的旧设计会让"LLM 测绿了 TTS 也显示绿"——语义错位。
- 读取时**内嵌进 `Provider.health[]`**，没有 ProviderWithHealth 壳。背书：Kubernetes spec/status——**写分离、读组装**；写入路径（配置 upsert vs 探活覆盖写）物理隔离互不误伤，读取永远是一个对象喂饱一个页面。
- 备份语义也受益：健康是源机器观测值，跨机导入等于撒谎；独立表让"备份/导入不带遥测"是自然默认。

### 5. URL 显式化，代码零猜测

模板/种子里每档协议必须显式写 `baseUrl`（`ProviderProtocolOption` 时代就是必填）。否决"默认地址兜底"：上游默认地址变化或档位顺序调整时，兜底会让某档协议悄悄继承错误的 URL。`resolveProviderConnection` 只读行里的事实，没有任何"猜地址"的路径。

### 6. Vision 与 LLM 同参数集

Vision 模型是支持视觉输入的 LLM，上下文窗口等参数与 LLM 同等必要：`contextWindow` 必填，`maxOutput/toolCall/reasoning/temperature/inputImage` 可空。`capability` 判别存在的理由是绑定与探活按能力分流，不是参数形状不同。

## 二、结构

### 数据模型（profile.db）

```text
providers                id PK · name · icon_id NULL · auth_type('none'|'bearer') · key_value NULL(明文) · 时间戳
   │                     无启停列：Provider 配不配置由用户增删表达；id 创建后不可改
   ├─ provider_capabilities  (provider_id, capability) PK · active_protocol NULL
   │                     · models_dev_id NULL
   │                     active_protocol=NULL = 该能力停用（协议行保留）
   ├─ provider_protocols (provider_id, capability, protocol) PK · base_url
   │                     同能力可配多档（DeepSeek 双协议），切 active 不丢另一档地址
   ├─ provider_health    (provider_id, capability) PK · status · last_probed_at · latency_ms · last_error
   ├─ provider_models    (provider_id, capability, model_id) PK · name NULL · source('user'|'dev') · enabled · 能力参数列
   │                     name = 目录同步自带的显示名快照（空则回退 model_id）
   │                     user 手写（可编辑）+ dev 目录同步（禁修改、参数以目录为准、enabled 不动）；FK 级联到能力行
   └─ model_bindings     module PK（memory/title/lightrag-embed/lightrag-llm/tts/stt/vision）
                         → (provider_id, capability, model_id)，只能绑已启用模型，且绑定入口断言连接可解析
```

种子与演进：`001_initial.sql` = schema 基线；`002_provider_seeds.sql` = 19 个内置 provider 全量内容；`003+` = 演进（只增不删、INSERT OR IGNORE、WHERE EXISTS 父行）。

### 运行期解析

```text
resolveConnection(providerId, capability)                class Providers 薄编排
  = store.get 行（含 capabilities/health join）
  + provider 行的 key_value
  → resolveProviderConnection(provider, keyValue, capability)   纯函数
       无 active 协议档    → capability_disabled
       bearer 且无 key     → credential_missing
       none               → 无 apiKey
  → ProviderConnection { protocol, baseUrl, apiKey? }  → 六个执行包 Adapter 直接消费
```

### 模型发现（llm/vision 目录同步 → SQL 单一来源）

```text
启动后台 refreshCatalog（快照缺失/损坏为空目录，不阻塞主链路）
  → Provider 配置保存成功 or 池页点刷新：再拉一次目录 + syncDevModels 落 SQL
      新增行 enabled=0 / source='dev'；已有 dev 行参数以目录为准（enabled 不动）
  → 池页从 SQL 读全量（目录区与手填区同表），启停即拨 enabled 开关
embed/rerank/tts/stt：无目录覆盖，只能手写（source='user'）。
```

### 类型与主动词

```ts
interface Provider {
  id: string;                    // 用户选定或种子；创建后不可改
  name: string;
  iconId?: string;               // UI 图标注册表 key；undefined = 不渲染图标
  authType: 'none' | 'bearer';
  keyValue?: string;             // 全文；掩码与 👁 是前端渲染规则
  capabilities: ProviderCapability[];   // activeProtocol?/modelsDevId?/protocols[]
  health: ProviderHealth[];             // 按能力
}

class Providers {
  list / get                            // 一个对象含能力与内嵌健康
  create(input)                         // 只服务自建；按能力分区创建单能力 Provider；id 显式语义 slug（主键）
  update(id, input)                     // 内置配置走这里；capability 单能力 delta（含 removedProtocols 删档：激活档被删自动切剩余第一档，删到最后一档拒绝）
  delete(id)                            // 先查 model_bindings 冲突（provider_in_use）
  recordHealth(providerId, capability, health)
  resolveConnection(providerId, capability)
}

class ProviderModels {
  save(input)                           // 手写 upsert（user 行）；dev 行禁修改
  setEnabled(providerId, capability, modelId, enabled)   // 停用被绑定模型 → model_in_use（带 conflicts）
  delete(providerId, capability, modelId)                // 被绑定 → model_in_use
  syncDevModels(providerId, 'llm'|'vision')              // 目录同步落 SQL（新增默认禁用）
}

resolveProviderConnection(provider, keyValue, capability)   // 纯函数，实体不带方法
```

错误统一 `ProviderError`：`already_exists` / `invalid_configuration` / `not_found` / `capability_disabled` / `credential_missing` / `provider_in_use` / `provider_capability_in_use` / `model_not_found`。

### 文件结构

```text
src/providers/
├─ types.ts           能力/协议词汇、ProviderConnection、isProtocolForCapability
├─ providers.ts       Provider/ProviderCapability/ProviderStore 端口
│                     + class Providers + resolveProviderConnection 纯函数
├─ models.ts          ProviderModel 家族（llm/vision 同参数集）+ ProviderModels
├─ modelBindings.ts   ModelBinding + ModelBindings（9 个业务位）
├─ errors.ts          ProviderError
├─ catalog/modelsDevCatalog.ts   api.json 纯解析 + getModelsDevCatalog/refreshModelsDevCatalog
├─ catalog/models-dev.json       models.dev 本地快照（gitignored，拉取产物）
└─ tests/
```

依赖方向：`storage ──> providers`（Repo 实现端口，type-only）；本包不导入任何执行面 Adapter，Probe 执行器由组合层拥有。
