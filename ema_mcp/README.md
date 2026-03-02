# ema_mcp 模块

`ema_mcp/` 负责把 MCP 远程工具接入到 EmaAgent 的本地工具系统。

---

## 目录内容

| 文件 | 作用 |
|---|---|
| `client.py` | `MCPClient`：封装 mcp SDK 的 stdio 会话 |
| `bridge.py` | `MCPToolBridge`：把 MCP Tool 适配为 `BaseTool` |
| `manager.py` | `MCPManager`：多 MCP Server 生命周期管理 |
| `__init__.py` | 对外导出 `MCPClient/MCPToolBridge/MCPManager` |

---

## 工作流

1. `MCPManager` 读取 `config/mcp.json` 的 `mcp_servers`。
2. 对 `enabled=true` 的服务创建并启动 `MCPClient`。
3. 从远程工具元数据生成 `MCPToolBridge` 列表。
4. 由 `EmaAgent.initialize_mcp()` 注入到 `ReAct` 工具集合。

---

## `mcp.json` 关键字段

```json
{
  "mcp_servers": {
    "amap": {
      "enabled": true,
      "command": "npx",
      "args": ["-y", "@amap/amap-maps-mcp-server"],
      "env": {
        "AMAP_MAPS_API_KEY": "${AMAP_MAPS_API_KEY}"
      },
      "description": "高德地图 MCP 服务"
    }
  }
}
```

说明：

- `env` 支持 `${ENV_NAME}` 模板展开。
- `enabled=false` 的服务不会在启动期拉起。

---

## 生命周期注意事项

- 启动：`await manager.start_all()`
- 关闭：`await manager.stop_all()`

在后端 `Ctrl+C` 触发的 shutdown 场景里，底层可能出现 `CancelledError`；当前实现已在关闭流程中做容错，避免中断整体退出。
