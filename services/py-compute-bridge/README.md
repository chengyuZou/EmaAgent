# py-compute-bridge

Python 重计算服务，为 EmaAgent 提供向量与图计算能力。

## 定位

负责：
- 文本向量化（Embedding）
- 召回结果重排（Rerank）
- Narrative LightRAG 检索
- 图记忆构建与查询
- 向量 ANN 搜索

**纯计算服务，无业务状态**，通过 HTTP 接口与 TS 侧通信。

## 目录结构

```
app/
  main.py              # FastAPI 入口 + 路由注册
  narrative_service.py # LightRAG narrative 查询
  memory_service.py    # 图记忆构建/查询 + ANN 搜索
  embedding_service.py # 文本向量化 + 重排
  schemas.py           # Pydantic 请求/响应模型
```

## 接口清单

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | 健康检查 |
| POST | /embed | 文本向量化 |
| POST | /rerank | 召回重排 |
| POST | /narrative/query | Narrative 检索 |
| POST | /memory/graph/build | 图记忆构建 |
| POST | /memory/graph/query | 图记忆查询 |
| POST | /memory/ann/search | 向量 ANN 搜索 |

## 当前状态

骨架阶段。`main.py` 与 `requirements.txt` 已创建，各 service 待实现。

## 设计决策（待实现）

1. **向量索引宿主**：内存中维护 `faiss` 或 `hnswlib` 索引，TS 侧通过 ID 反查文本。
2. **索引持久化**：每 30s / 100 条增量异步刷盘到 `<appDataDir>/indices/`，SIGTERM 全量刷盘。
3. **降级策略**：TS 侧 Circuit Breaker 管理，本服务崩溃时不阻塞主流程。

## 依赖

- `fastapi`、`uvicorn`、`pydantic`
- `lightrag-hku`、`faiss-cpu`、`numpy`

## 启动方式

```bash
# 开发
uvicorn app.main:app --host 127.0.0.1 --port 8001

# 桌面端由 Tauri Sidecar 自动拉起
```
