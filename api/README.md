# api 模块

`api/` 是后端服务入口层，按「入口 / 协议 / 业务」三层组织：

- 入口层：`main.py`
- 协议层：`routes/`
- 业务层：`services/`

---

## 目录结构

```text
api/
├── main.py          # FastAPI 入口、路由注册、启动预热、静态资源挂载
├── routes/          # REST / WebSocket 协议层
├── services/        # 业务服务层
└── routes/schemas/  # 请求与响应模型
```

---

## 生命周期说明

`main.py` 在应用生命周期中做两件关键事：

1. `startup`
- 预热 Narrative（减少首请求冷启动）。
- 初始化 MCP（启动已启用的 MCP Server 并注入工具）。

2. `shutdown`
- 调用 `EmaAgent.close()` 统一关闭 MCP / Narrative / TTS 相关资源。

---

## Settings 接口现状（重点）

设置页已从单一“全量保存”演进为“分区保存”，对应五个分区：

- API：`PUT /api/settings/api`
- MCP：`PUT /api/settings/mcp`
- 主题：`PUT /api/settings/theme`
- 字体：`PUT /api/settings/font`
- 路径：`PUT /api/settings/paths`

兼容接口 `PUT /api/settings` 仍保留，用于一次性更新。

---

## 子文档

- [`api/routes/README.md`](./routes/README.md)
- [`api/services/README.md`](./services/README.md)
