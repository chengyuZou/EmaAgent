# config 模块

`config/` 管理运行时路径、模型配置和用户设置

---

## 文件说明

| 文件 | 作用 |
|---|---|
| `paths.py` | 全局路径中心 配置读取 `.env` 解析 目录初始化 |
| `config.json` | 主配置 默认模型目录与服务参数 |
| `config.yaml` | 主配置 YAML 版本 |
| `settings.json` | 用户运行时设置（模型 UI 路径） |

---

## 配置优先级

`LLMConfig.from_runtime(...)` 采用以下来源合并：

1. `config.json` / `config.yaml` 默认值
2. `settings.json` 用户选择值
3. `.env` 环境变量密钥

---

## 关键路径

由 `PathConfig` 统一输出：

- `data/sessions/`
- `data/audio/cache/`
- `data/audio/output/`
- `data/music/`
- `narrative/memory/*_Loop/`
- `logs/`

---

## 初始化入口

```python
from config.paths import init_paths
paths = init_paths(PROJECT_ROOT)
paths.ensure_directories()
```

