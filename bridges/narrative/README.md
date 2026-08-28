# Narrative Bridge

EmaAgent 的剧情检索辅助进程：把 LightRAG 的三条时间线检索能力包装成一个受控的 loopback HTTP 服务，由 Rust Host 监督生命周期。它只承载 Narrative 的 LightRAG 能力，不是通用 Python 工作进程；WebView 不直接访问它，一切流量经 Application Server。

## 请求模型

Bridge 不持有任何全局 LLM 状态：

- **Embedding**：进程级常量。Server 从 `lightrag-embed` 模型绑定解析连接，启动时经 `POST /internal/configure` 送达一次；与既有剧情向量同属一个向量空间，进程内不可更换（换绑必须重启 Bridge，二次 configure 返回 409）。
- **Narrative LLM**：每次 Recall 由请求体携带（`llm.baseUrl/apiKey/modelId`，openai-chat 协议）。一次 Recall 建一个 `AsyncOpenAI` Client，周目路由与各时间线的关键词提取共用，Recall 结束关闭。不同 Session 的并行 Turn 可各自携带不同连接。

三个 LightRAG 实例在 configure 时打开一次（秒级），查询经 `QueryParam.model_func` 注入当次连接；构造期占位函数保证"忘记注入"会立刻报错而不是用到过期模型。

## 目录

```text
core/
├─ main.py         # 向 OS 申请端口并以 uvicorn.Server 启动
├─ application.py  # FastAPI 生命周期、认证与各端点装配
├─ contracts.py    # Server 与 Bridge 的 Pydantic 请求响应（全包字段唯一来源）
├─ content.py      # 剧情根目录与三条固定时间线
├─ model_client.py # 一次 Recall 的 LLM 客户端与进程级 Embedding 闭包
├─ light_rag.py    # 三个 LightRAG 实例的打开、查询和关闭
├─ recall.py       # 周目路由、多时间线并行查询与部分失败
├─ prompt.py       # 固定剧情摘要与周目路由 Prompt
└─ ready.py        # 真正开始监听后向 Rust Host 原子发布实际端口
```

## 环境变量

| 变量 | 含义 |
|---|---|
| `EMA_SHARED_SECRET` | 进程间认证密钥（必填，否则拒绝启动） |
| `EMA_NARRATIVE_DIR` | 剧情数据根目录（含三条时间线子目录） |
| `EMA_READY_FILE` | Rust Host 下发的端口回执文件路径 |

## 接口

- `GET /health`：进程与 Narrative 能力状态（公开，无需认证）。
- `POST /internal/configure`：送达进程级 Embedding 连接，同步建立时间线实例后返回；进程内只接受一次。
- `POST /internal/shutdown`：优雅退出（停收连接、排空在途请求、执行 lifespan 清理）。
- `POST /narrative/recall`：原子 Recall——周目路由 + 多时间线并行检索，只返回检索背景，不生成最终回答。

除 `/health` 外所有接口要求 `X-Ema-Secret` 头。

## 开发与测试

```powershell
pnpm --filter @ema-agent/narrative-bridge dev    # uv run ema-narrative-bridge
pnpm --filter @ema-agent/narrative-bridge test   # uv run pytest
```
