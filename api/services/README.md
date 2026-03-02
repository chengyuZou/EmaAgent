# api/services 模块

`api/services/` 是业务实现层，负责配置、状态、文件、外部 API 与运行时资源管理。

---

## 服务清单

| 文件 | 类/函数 | 职责 |
|---|---|---|
| `settings_service.py` | `SettingsService` + 子模块 | 设置读取、分区保存、运行时刷新 |
| `session_service.py` | `SessionService` | 会话管理（创建/删除/重命名/列出） |
| `tts_service.py` | `APITTSService` | TTS 生成、分段合并、缓存处理 |
| `news_service.py` | `NewsService` | 新闻聚合、去重、排序 |
| `music_service.py` | `MusicService` | 本地音乐索引、搜索、转换 |
| `live2d_service.py` | `Live2DService` | 表情状态、口型参数 |
| `game_service.py` | `GameService` | 拼图资源目录管理与处理 |

---

## `settings_service.py` 模块化结构

当前 `SettingsService` 已作为“调度层”，具体逻辑下沉到子模块：

- `SettingsRuntime`
- `UiSettingsSupport`
- `ApiSettingsModule`
- `PathSettingsModule`
- `ThemeSettingsModule`
- `FontSettingsModule`
- `McpSettingsModule`

这种结构的目标：

1. 降低单类职责混杂。
2. 让五个设置分区对应清晰的处理边界。
3. 保留 `SettingsService` 作为对外统一入口，便于路由层调用。

---

## 与其它目录关系

- 依赖 `config/paths.py` 统一路径。
- 与 `api/routes/` 形成“协议层 -> 业务层”调用关系。
- `settings_service` 会触发 `agent` / `tts_service` 的运行时刷新。
- `mcp` 配置通过 `config/mcp.json` 与 `ema_mcp/` 运行时对接。
