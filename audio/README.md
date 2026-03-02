# audio 模块

`audio/` 提供 TTS 相关的统一抽象、Provider 工厂与客户端实现。

---

## 目录结构

```text
audio/
├── base.py                 # TTS 抽象基类与公共能力
├── factory.py              # Provider 工厂，根据配置创建客户端
├── tts_manager.py          # 本地 TTS 任务管理（非 server_mode）
└── clients/
    ├── siliconflow.py      # SiliconFlow TTS 客户端
    └── vits_simple.py      # VITS Simple API 客户端
```

---

## 设计说明

- `base.py`
- 定义统一接口，约束不同 TTS Provider 的调用方式。
- 处理 API Key 解析（直填值或环境变量名）等通用逻辑。

- `factory.py`
- 按 `provider` 创建具体客户端，避免业务层直接依赖实现细节。

- `tts_manager.py`
- 管理文本分段、异步合成与落盘流程。
- 主要用于本地模式；服务端模式优先走 `api/services/tts_service.py`。

---

## 与 API 层关系

- API 运行时主要入口：`api/services/tts_service.py`
- Settings 切换 Provider：`POST /api/settings/tts/switch`
- 配置来源：`settings.json` 的 `api.tts` 块 + `.env` 中的密钥

---

## 使用建议

- 不需要密钥的 Provider（如本地 VITS）可保留 `api_key="NOT_REQUIRED"`。
- 对外分发时，建议将真实密钥只放在 `.env`，配置文件仅保存 `api_key_env`。
