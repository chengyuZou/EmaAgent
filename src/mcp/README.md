# @ema-agent/mcp — MCP 域(Server 配置、连接生命周期、Tool 适配、Registry 目录源)

MCP Server 的配置、连接、工具发现、执行与远程目录来源的唯一业务所有者。
V1 只支持 `stdio` 与 Streamable HTTP 两种传输;已弃用的 SSE 在导入与读取两侧都明确报错,不静默转换。

## 稳定公共接口(只允许从这里消费)

```ts
// 装配与运行
McpServerStore({ repo, credentials })   // server 配置与工具缓存的持久化
McpRegistry(store, toolRegistry, stdioGate?, stdioEnabled?)
  connect/disconnect/callTool/probe/primeFromCache/discoverUncached
  register/findByName/setEnabled/remove/listRecords/getConnection(s)

// 配置与类型
McpServerConfigSchema / McpStdioConfigSchema / McpHttpConfigSchema
McpInstallProvenanceSchema              // manual | import | registry 三形态
McpServerConfig / McpServerRecord / McpConnection / McpToolInfo / McpStdioLaunchIntent

// 粘贴导入(Claude Desktop / mcp.so / ModelScope JSON 或裸 URL)
parseImportedMcpServers(input, fallbackName?)

// Registry 目录源(官方协议;镜像只是同协议的另一条 URL)
McpRegistrySourceStore / OFFICIAL_REGISTRY_SEED
fetchRegistryEntries(baseUrl, { maxPages?, maxEntries? })   // 固定 ?version=latest
fetchRegistryEntryLatest(baseUrl, entryName)                // 更新检查
resolveRegistryEntry(raw)                                   // 条目 → 安装规格
installRegistryEntry({ store, source, entry, name?, inputs? })

// Tool 结果
McpToolOutput / projectMcpToolOutput
```

## 其他包不得复用/穿透的

- **`connection.ts`、`runtime-utils.ts`、`toolSchemaLimits.ts`、`registrySources/` 内部**不是公共件;连接只能经 `McpRegistry`/`probe` 建立。
- **前端不得 import 本包类型**;server/源/条目经 server Route 下发 wire 投影。
- 不得绕过 `McpServerStore` 直写 `mcp_servers` 表——`config_json` 里的 env/headers 值是 credential 信封,只有 Store 知道加解密边界。
- `McpRegistry` 的连接状态机(generation/primed/refresh)是内部实现;消费方只读 `getConnection(s)` 投影。

## 不变量

- **凭据边界**:stdio `env` 与 http `headers` 的全部值在写边界 `protect`、读边界 `reveal`,AAD 绑定记录 id;domain 形式永远是明文,连接层不知道加密存在。备份导出只含密文信封。
- **启动路径**:`primeFromCache()` 用 SQL `tools_cache` 预填工具(不拉起进程),`discoverUncached()` 后台探测无缓存 server;真实 transport 在首次 `callTool` 懒建连。不做开机急切全连。
- **生命周期配对收在领域内**:禁用即断开并摘除全部工具;启用即以缓存恢复惰性可见;删除即先断开。禁用服务器的 `connect`/`callTool` 一律拒绝(不拉进程、不发请求)。`callTool` 走 `connectConfig` 管道:懒连接与配置漂移重连共用 configKey 判别,更新配置后不会用到旧连接。
- **Tool 注册**:MCP 工具经 `ToolRegistry.registerMcpBatch` 原子替换;当前根 Turn 的 ToolPool 已冻结,`list_changed`/重连只影响下一根 Turn。
- **annotations 单向**:远端自报 `readOnlyHint` 只进 UI 展示;`destructiveHint` 只能升级为强制询问(`checkPermissions` 返回 ask,先于 bypassPermissions),任何自报都不能让工具自我放行或开放并发。
- **结果两道阀**:协议层 1MB/100块/256KB 二进制(防异常 Server);模型投影走 Tool 统一的 50KB 结果预算。`_meta` 只进 data 槽,绝不发给模型。

## 失败语义

- 单条 Registry 条目 Schema 不符 → 跳过并计数(`skipped`),不拖垮整页;
- 单源浏览失败 → 该源返回 error,其他源正常(路由层降级);
- 无精确版本的包、仅 SSE 的条目、带模板参数的条目 → `installable:false` + 用户可读原因,不生成坏配置;
- 连接意外断开 → 标 failed、保留最后缓存工具;下一次 callTool 懒重连,不重放可能已有副作用的失败调用;
- 首次探测失败的 server 无缓存可预填,工具不可见,直到管理面手动连接/探测成功一次(诚实失败,不拿猜测 Schema 冒充)。

## 接线契约(归各装配方,本包不接线)

- server:`McpServerStore` 注入 `CredentialFacade` 单例;`McpRegistrySourceStore.ensureOfficialSeed()` 在启动期调用;stdio 拉起经 `stdioGate` 接非 Turn 的用户批准通道。
- turnExecution:MCP 工具经全局 `ToolRegistry` 进 ToolPool,本包不参与每 Turn 冻结。
- 备份:导入侧遇 reveal 失败的受保护值应剥除并要求用户重填(归备份批)。

## 已冻结的 V1 不做

- 不恢复 SSE transport;不做 OAuth 流程(静态鉴权走 headers + credential 加密);
- 不做 MCP 资源的落盘外置(音频/未知二进制投影为说明文本,等第一个真实消费方);
- ModelScope token 同步挂起(hosted URL 24h 过期,粘贴导入已覆盖);不做 git 仓库市场。
