# MCP

本包只负责 MCP 已安装服务器、连接生命周期、Tool 投影和 Official MCP Registry 市场业务。MCP Prompt、Resource、OAuth 与任意市场地址不属于 V1。

## 事实边界

- `mcp_servers` 保存已安装配置、启用意图、安装来源与上次成功的 Tool 缓存。
- `McpRegistry` 保存当前进程内的真实连接状态；每台服务器有独立连接槽，可同时连接多台。
- `mcp_market_entries` 按 `source + externalId` 保存市场列表缓存；它不保存安装配置，也不复用 `tools_cache`。
- `ToolRegistry` 只注册当前可调用的 Tool。离线 Tool 缓存供设置页展示，不代表服务器可调用。

## 公开入口

- `McpServerStore`: 已安装记录读写与 Tool 缓存。
- `McpRegistry`: `save`, `setEnabled`, `connectInBackground`, `disconnect`, `remove`, `probe`, `callTool`。
- `McpMarketService`: `load`, `refresh`, `detail`, `install`。
- `OfficialRegistryAdapter`: Official MCP Registry 的真实 API 适配。

## 连接语义

```text
应用启动
  -> 用 cachedTools 暂时恢复启用服务器的 Tool 描述
  -> 所有 enabled 服务器并发后台连接
  -> connected: 用实时列表替换缓存并写回 SQL
  -> failed: ToolRegistry 移除该服务器 Tool, UI 仍可展示 cachedTools
```

- 新增、JSON 导入、编辑保存与重新启用都会立即进入后台连接，HTTP 请求不等待连接完成。
- 编辑先断开旧连接，再完整保存新配置。
- 禁用或删除会取消连接、刷新和重试，并移除当前 Tool。
- Streamable HTTP 在成功连接后意外断开，会按 1、2、4、8、16 秒重试五次。
- stdio 进程意外退出不会自动重启。
- 测试连接不落库，也不改变正式连接。
- stdio 启动没有第二套 MCP 批准。用户保存并启用配置就是管理面授权；LLM 调用 MCP Tool 仍统一经过中央 Tool Permission。

## 市场语义

后端市场当前只有 Official MCP Registry。`McpMarketSource`、SQL 主键、Service、Route 与 Desktop API 都保留来源维度，但不存在来源 CRUD、自定义 URL 或通用 Registry 协议。MCP.so 没有进入 Adapter、SQL 缓存或安装来源；以后只会作为前端外链入口，位置和样式等 UI 讨论完成后再实现。

```text
进入市场
  -> SQL 有缓存: 按搜索词和页码立即返回 40 条
  -> SQL 无缓存: 等待首次刷新
手动刷新
  -> OfficialRegistryAdapter 从稳定的 v0.1 API 拉取真实来源
  -> 事务替换该来源缓存
  -> 发带 source 的 mcp_market_changed
刷新失败
  -> 保留旧缓存并返回错误
```

市场列表缓存可以保存完整 Registry,但列表 Route 不得全量返回。Desktop 页面自持当前搜索词、页码与最多 40 条结果,不把市场查询结果放入全局 Store。搜索在 SQLite 缓存上执行;上一页、下一页和页码输入只替换当前页,卡片动画索引也只按当前页计算。已有缓存不会因为打开页面自动刷新,只有用户点击刷新才同步上游。

市场安装必须在点击时读取真实详情并生成明确的 `McpServerConfig`。需要的 Header 或环境变量由用户补齐后写入 `mcp_servers`。市场列表缓存不保存第三方原始响应或万能 JSON。

## 跨进程事件

- `mcp_connection_changed`: 当前连接状态变化，Desktop 重读已安装列表。
- `mcp_market_changed`: 某个已接入来源刷新完成，已打开该来源的窗口重读缓存。

Server Route 是 HTTP 契约唯一来源；Desktop API 类型从 Hono RPC 推导，前端不得再定义另一套 MCP wire interface。
