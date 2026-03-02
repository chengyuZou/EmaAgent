# api/routes 模块

`api/routes/` 负责协议适配：参数校验、请求分发、响应结构组织。

---

## 路由清单

| 文件 | 主要路径 | 说明 |
|---|---|---|
| `chat.py` | `/api/chat` `/api/ws/chat` | 聊天主入口、流式输出、附件上传 |
| `sessions.py` | `/api/sessions*` | 会话管理（列表/创建/删除/重命名） |
| `settings.py` | `/api/settings*` | 设置读取、分区保存、状态查询 |
| `audio.py` | `/api/audio*` | 音频缓存与输出访问 |
| `news.py` | `/api/news*` | 新闻聚合检索 |
| `music.py` | `/api/music*` | 本地音乐播放与管理 |
| `live2d.py` | `/api/live2d*` | Live2D 状态与口型控制 |
| `game.py` | `/api/game/*` | 拼图资源相关接口 |

---

## `settings.py` 主要端点

- `GET /api/settings`
- `PUT /api/settings`（兼容全量保存）
- `PUT /api/settings/api`
- `PUT /api/settings/mcp`
- `PUT /api/settings/theme`
- `PUT /api/settings/font`
- `PUT /api/settings/paths`
- `GET /api/settings/models`
- `PUT /api/settings/model`
- `GET /api/settings/tts`
- `POST /api/settings/tts/switch`
- `GET /api/settings/status`
- `POST /api/settings/pick-directory`

---

## 设计约束

- 路由层保持“薄”：不承载复杂业务逻辑。
- 复杂逻辑统一下沉 `api/services/`。
- 请求/响应数据结构通过 `api/routes/schemas/` 统一约束。
