# MCP

[English](./README.md)

本包连接 MCP 服务器, 把远端工具转换成 Ema 工具, 保存服务器设置, 并提供 Official MCP Registry 市场.

## 入口

- `McpServerStore` 通过 `McpServersRepo` 读写安装配置和上次成功发现的工具列表.
- `McpRegistry` 管理连接和工具注册. 设置路由使用 `listServers`, `getServer`, `save`, `setEnabled`, `disconnect`, `remove`, `probe`; 工具执行使用 `callTool`.
- `parseImportedMcpServers` 接收已解析的 JSON 对象, 支持 `mcpServers` 或 `servers` 包装, 名字到配置的映射, 以及单服务器配置. 返回经过校验的 stdio 或 Streamable HTTP 配置, 遇到 SSE 配置直接报错.
- `McpMarketService`, `McpMarketStore`, `OfficialRegistryAdapter` 处理市场列表, 刷新, 详情和安装.
- `McpLocalCommandEnvironment.inspect` 查找宿主 PATH 中的 `npx`, `uvx`, `bunx`, Python 3, 读取版本供设置页展示.

导入示例见英文 README. 导入路由先解析用户 JSON, 再保存配置. 保存并开始后台连接后即可返回, 不等待连接成功.

## 连接和工具

Server 装配时创建 Store 和 Registry, 先用 `primeFromCache` 注册已启用服务器的缓存工具, 再用 `connectEnabledInBackground` 开始后台连接. 缓存让模型在启动阶段就能看到工具说明, 但调用仍需等待实时连接和工具发现完成.

正常顺序是: 注册缓存工具, 后台握手, 读取工具列表, 批量注册实时工具并移除已消失的缓存工具, 通知连接成功, 写入工具缓存. 英文 README 的时序图展示了这些调用.

需要连接时才加载 SDK Client 和对应传输, 每条连接拥有独立 Client. 握手超时为 30 秒, 从模块加载完成后开始计算; 工具发现另有 15 秒超时. 服务器成功返回空列表是有效结果, 发现失败则连接失败.

相同配置的并发请求共用连接任务. 单次调用取消只结束自身等待, 不取消共享连接. 断开或替换会取消连接和刷新任务; generation 计数阻止旧任务和迟到的关闭回调改写新状态.

初次发现前先订阅工具变化通知, 多次通知共用一个刷新循环. 新工具整批校验成功后才替换注册内容. 刷新失败保留原列表, 缓存写入失败保留实时连接.

禁用或删除会注销工具并取消重试. 已成功连接的 HTTP 服务器意外关闭后, 按 1, 2, 4, 8, 16 秒间隔重试. stdio 进程退出不自动重启, 后续直接调用可以再次尝试连接. `probe` 使用临时连接, 最后关闭, 不保存配置或注册工具.

## 数据保存与模型结果

`mcp_servers` 保存配置, 启用状态, 安装来源和工具缓存. 环境变量值与 HTTP Header 以明文 JSON 保存. `envPassthrough` 只保存变量名, 连接时从宿主读取当前值. 合并顺序为 SDK 默认值, 透传值, 显式 `env` 值.

`listServers` 返回摘要和 `toolCount`, SQLite 只计算缓存工具数量, 不返回整份定义. `getServer` 在线时返回实时工具, 离线时返回缓存. Desktop 全局保存摘要, 需要时再请求详情. 连接状态只保存在当前进程中.

远端 `readOnlyHint` 不用于放行权限或允许并发. `destructiveHint` 为 true 时要求批准, 其余调用交给 Permission 按用户规则和模式判定. 保存并启用本地服务器允许启动配置的进程, 工具调用仍经过正常权限流程.

每台服务器最多接受 256 个工具和 1 MiB 序列化定义. `callTool` 使用配置的超时或默认 120 秒, 取消会传给 SDK. 远端 `isError` 结果转为 `McpToolCallError`.

结果保存限制大小后的 `content` 和可选 `structuredContent`. Content 最多检查输入前 100 块, 每个编码后的二进制块最多 256 KiB, 在 1 MiB 预算内预留删减提示空间. Structured content 有独立的 1 MiB 限制, 超限时整体丢弃. 远端 `_meta` 不保存.

`projectMcpToolOutput` 原样传递文本, 把图片转换为 `image_data`, 给资源文本加来源 URI, 最后追加结构化内容的 JSON 文本. 音频, 非图片二进制资源和未知块返回说明文字.

## 市场缓存与通知

Official Registry Adapter 读取 `v0.1` 服务器接口. `mcp_market_entries` 按来源和 externalId 保存列表字段, `mcp_market_fetch_state` 保存上游下一页 cursor. 搜索在 SQLite 完成, 每页返回 40 条.

- 无缓存时只等待上游第一页, 连同 cursor 写入后返回, 剩余页在后台读取.
- 缓存未完成时立即返回已有结果, 从保存的 cursor 继续读取.
- 缓存已完成时立即返回, 本进程首次打开市场时开始一次后台刷新.
- 完整刷新先读齐所有页, 再用一个事务替换该来源. 失败保留原缓存; 分页续读失败保留已经保存的页.

安装时重新读取详情, 生成明确配置, 要求用户填齐必需 Header 或环境变量, 再保存服务器及其 Official Registry 条目 ID.

配置和工具缓存写入后发出 `mcp_servers_changed`, 连接状态改变时发出 `mcp_connection_changed`, 市场写入后发出带来源的 `mcp_market_changed`. Server 转发事件, Desktop 对应视图重新读取当前数据. HTTP 形状由 `apps/server/src/routes/mcp` 定义, Desktop API 类型从路由推导.

## 阅读与验证

连接流程看 `registry.ts`, Ema 工具约定看 `discovery.ts`, 取消和结果转换看 `execution.ts`. 配置保存看 `store.ts`, 市场缓存读写看 `market/marketService.ts`.

运行 `pnpm --filter @ema-agent/mcp test`. 测试覆盖配置导入, 明文凭据, 连接取消与关闭, 工具定义限制与权限, 结果转换与大小限制, 市场分页与安装. `src/storage/tests/repos/mcp-market.integration.test.ts` 验证市场 SQL 操作. 本包网络测试使用模拟 SDK Client 和 HTTP 响应, 不连接真实市场.
