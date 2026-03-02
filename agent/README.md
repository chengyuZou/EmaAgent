# agent 模块

`agent/` 是智能体编排层，负责把会话、模型、工具、Narrative 与 MCP 工具注入串成统一执行流。

---

## 目录内容

| 文件 | 作用 |
|---|---|
| `EmaAgent.py` | 主调度器，统一入口：`run` / `run_stream` |
| `react.py` | ReAct 推理循环与工具调用逻辑 |
| `__init__.py` | 模块导出 |

---

## 核心职责

### `EmaAgent.py`

- 初始化并持有 `LLMClient`、`Session`、`NarrativeMemory`、`ReActAgent`。
- 统一分发三种模式：`chat` / `agent` / `narrative`。
- 在启动期懒加载 Narrative（带并发锁，避免重复初始化）。
- 通过 `initialize_mcp()` 读取 `config/mcp.json`，启动 MCP Server 并把工具注入 ReAct。
- 在关闭阶段统一释放资源（MCP、Narrative、TTS）。

### `react.py`

- 负责 `think -> act` 循环。
- 解析 LLM `tool_calls` 并调用 `ToolCollection.execute(...)`。
- 将工具结果回写上下文，驱动下一轮推理。

---

## 与 `ema_mcp` 的关系

`EmaAgent` 通过 `from ema_mcp.manager import MCPManager` 接入 MCP 生态：

1. `MCPManager.start_all()` 启动所有启用的 MCP Server。
2. `MCPToolBridge` 把远程 MCP Tool 适配为本地 `BaseTool`。
3. `self.agent.tools.add_tools(*tools)` 完成动态注入。

这样可以在不改 `ReAct` 主流程的前提下，扩展任意 MCP 工具。

---

## 上下游依赖

上游调用：

- `api/routes/chat.py`
- `api/main.py`（startup/shutdown 生命周期）

下游依赖：

- `llm/`
- `memory/`
- `narrative/`
- `ema_mcp/`
- `api/services/live2d_service.py`
- `api/services/session_service.py`
