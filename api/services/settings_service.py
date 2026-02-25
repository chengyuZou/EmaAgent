"""
设置服务模块。
"""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import HTTPException

from api.routes.schemas.settings import (
    ApiConfigModel,
    DirectoryPickerRequest,
    PathConfigModel,
    SwitchModelRequest,
    SwitchTtsProviderRequest,
    SystemStatusResponse,
    UiConfigModel,
    UiFontModel,
    UiThemeModel,
    UpdateSettingsRequest,
)
from audio.base import looks_like_env_key_name, resolve_provider_api_key
from config.paths import get_paths
from utils.logger import logger


PROVIDER_ENV_MAP: Dict[str, str] = {
    "deepseek": "DEEPSEEK_API_KEY",
    "openai": "OPENAI_API_KEY",
    "qwen": "QWEN_API_KEY",
}
DEFAULT_SELECTED_MODEL = "deepseek-chat"
DEFAULT_TTS_PROVIDER = "siliconflow"
MASK_CHAR = "•"


def _deep_merge(base: Dict[str, Any], update: Dict[str, Any]) -> Dict[str, Any]:
    """
    递归合并字典。

    Args:
        base (Dict[str, Any]): 被更新的字典。
        update (Dict[str, Any]): 覆盖来源字典。

    Returns:
        Dict[str, Any]: 合并结果。

    Example:
    ```
        base = {"api": {"temperature": 0.7}, "paths": {"data_dir": "./data"}}
        update = {"api": {"temperature": 0.9}, "paths": {"log_dir": "./logs"}}
        _deep_merge(base, update)
        => {"api": {"temperature": 0.9}, "paths": {"data_dir": "./data", "log_dir": "./logs"}}
    ```
    """
    for key, value in update.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
    return base


class SettingsService:
    """
    设置业务服务。
    """

    @property
    def paths(self):
        """
        获取路径配置对象。

        Returns:
            PathConfig: 路径配置对象。

        Example:
        ```
            get_paths().root
            => WindowsPath('D:/Github/EmaAgent')
        ```
        """
        return get_paths()


    def _mask_key(self, key: str) -> str:
        """
        脱敏密钥字符串。

        Args:
            key (str): 原始密钥。

        Returns:
            str: 脱敏后的字符串。

        Example:
        ```
            "mysecretkey123" -> "myse••••••••••23"
        ```
        """
        raw = str(key or "").strip()
        if not raw:
            return ""
        if raw.lower() == "not_required":
            return raw
        if len(raw) <= 6:
            return MASK_CHAR * len(raw)
        if len(raw) <= 12:
            return raw[:2] + (MASK_CHAR * (len(raw) - 4)) + raw[-2:]
        return raw[:8] + (MASK_CHAR * 8) + raw[-4:]

    def _is_masked_value(self, value: Any) -> bool:
        """
        判断值是否为脱敏占位。

        Args:
            value (Any): 待判断值。

        Returns:
            bool: 是否为脱敏占位。

        Example:
        ```
            _is_masked_value("SILICON••••••••_KEY")
            => True
        ```
        """
        raw = str(value or "").strip()
        return bool(raw and (MASK_CHAR in raw or "*" in raw))

    def _normalize_secret(self, value: Any, allow_not_required: bool = False) -> Optional[str]:
        """
        规范化密钥输入 让后端获得真正可使用的API Key。

        Args:
            value (Any): 原始输入。
            allow_not_required (bool): 是否允许 NOT_REQUIRED。

        Returns:
            Optional[str]: 可写入密钥；None 表示忽略更新。

        Example:
        ```
            _normalize_secret("DEEPSEEK_API_KEY")
            => None
            _normalize_secret("sk-live-real-key")
            => "sk-live-real-key"
        ```
        """
        raw = str(value or "").strip()
        if not raw or self._is_masked_value(raw) or looks_like_env_key_name(raw):
            return None
        if allow_not_required and raw.lower() == "not_required":
            return "NOT_REQUIRED"
        return raw

    def _load_settings(self) -> Dict[str, Any]:
        """
        读取 settings.json。

        Args:
            None

        Returns:
            Dict[str, Any]: settings 字典。

        Example:
        ```
            _load_settings()
            => {"api": {"selected_model": "deepseek-chat"}, "paths": {"data_dir": "./data", ...}}
        ```
        """
        settings = self.paths.load_settings()
        return settings if isinstance(settings, dict) else {}

    def _save_settings(self, settings: Dict[str, Any]) -> None:
        """
        保存 settings.json。

        Args:
            settings (Dict[str, Any]): 待保存配置。

        Returns:
            None

        Example:
        ```
            _save_settings({"api": {"selected_model": "gpt-4o"}})
            => settings.json 中 api.selected_model 被更新为 "gpt-4o"
        ```
        """
        self.paths.save_settings(settings)

    def _read_env_file(self) -> Dict[str, str]:
        """
        读取 .env 文件。

        Returns:
            Dict[str, str]: 键值映射。

        Example:
        ```
            .env 内容:
                DEEPSEEK_API_KEY=sk-deepseek
                OPENAI_API_KEY=sk-openai
            _read_env_file()
            => {"DEEPSEEK_API_KEY": "sk-deepseek", "OPENAI_API_KEY": "sk-openai"}
        ```
        """
        result: Dict[str, str] = {}
        env_file = self.paths.env_file
        if not env_file.exists():
            return result
        for raw_line in env_file.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            result[key.strip()] = value.strip().strip('"').strip("'")
        return result

    def _write_env_file(self, env_values: Dict[str, str]) -> None:
        """
        写入 .env 文件并尽量保留原有结构。

        Args:
            env_values (Dict[str, str]): 环境变量映射。

        Returns:
            None

        Example:
        ```
            _write_env_file({"OPENAI_API_KEY": "sk-new-openai"})
            => .env 文件中的 OPENAI_API_KEY 已被更新为 sk-new-openai
        ```
        """
        env_file = self.paths.env_file
        old_lines = env_file.read_text(encoding="utf-8").splitlines() if env_file.exists() else []
        consumed = set()
        new_lines: List[str] = []
        for raw_line in old_lines:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                new_lines.append(raw_line)
                continue
            key, _ = line.split("=", 1)
            key = key.strip()
            if key in env_values:
                new_lines.append(f"{key}={env_values[key]}")
                consumed.add(key)
            else:
                new_lines.append(raw_line)
        for key, value in env_values.items():
            if key not in consumed:
                new_lines.append(f"{key}={value}")
        content = "\n".join(new_lines).strip()
        env_file.write_text((content + "\n") if content else "", encoding="utf-8")

    def _resolve_models(self, config: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
        """
        获取模型映射。

        Args:
            config (Dict[str, Any]): 主配置。

        Returns:
            Dict[str, Dict[str, Any]]: 模型映射。

        Example:
            ```
            _resolve_models({"llm_models": {"gpt-4o": {"provider": "openai"}}})
            => {"gpt-4o": {"provider": "openai"}}
            ```
        """
        models = config.get("llm_models", {})
        return models if isinstance(models, dict) else {}

    def _resolve_selected_model(self, settings: Dict[str, Any], config: Dict[str, Any]) -> str:
        """
        解析当前选中模型。

        Args:
            settings (Dict[str, Any]): settings 配置。
            config (Dict[str, Any]): 主配置。

        Returns:
            str: 当前模型 ID。

        Example:
            ```
            settings={"api":{"selected_model":"gpt-4o"}}
            config={"llm":{"model":"deepseek-chat"}}
            => "gpt-4o"
            ```
        """
        api_cfg = settings.get("api", {}) if isinstance(settings.get("api"), dict) else {}
        llm_cfg = config.get("llm", {}) if isinstance(config.get("llm"), dict) else {}
        return (
            str(api_cfg.get("selected_model") or "").strip()
            or str(api_cfg.get("openai_model") or "").strip()
            or str(llm_cfg.get("model") or "").strip()
            or DEFAULT_SELECTED_MODEL
        )

    def _resolve_selected_model_meta(self, config: Dict[str, Any], selected_model: str) -> Dict[str, Any]:
        """
        获取模型元信息。

        Args:
            config (Dict[str, Any]): 主配置。
            selected_model (str): 模型 ID。

        Returns:
            Dict[str, Any]: 模型元信息。

        Example:
            ```
            selected_model="gpt-4o"
            => {"provider":"openai","base_url":"https://api.openai.com/v1","api_key_env":"OPENAI_API_KEY"}
            ```
        """
        return self._resolve_models(config).get(selected_model, {})

    def _resolve_selected_model_key(self, selected_model_meta: Dict[str, Any]) -> str:
        """
        解析选中模型密钥。

        Args:
            selected_model_meta (Dict[str, Any]): 模型元信息。

        Returns:
            str: 真实密钥。

        Example:
        ```
            selected_model_meta={"api_key_env":"OPENAI_API_KEY"}（环境变量已设置）
            => "sk-live-openai-key"
        ```
        """
        env_name = str(selected_model_meta.get("api_key_env") or "").strip()
        return os.getenv(env_name, "") if env_name else ""

    def _allowed_providers(self, config: Dict[str, Any]) -> set[str]:
        """
        获取允许的 provider 集合。

        Args:
            config (Dict[str, Any]): 主配置。

        Returns:
            set[str]: provider 集合。

        Example:
        ```
            _allowed_providers({"llm_models":{"gpt-4o":{"provider":"openai"}}})
            => {"deepseek","openai","qwen"}
        ```
        """
        providers = set(PROVIDER_ENV_MAP.keys())
        for item in self._resolve_models(config).values():
            if isinstance(item, dict) and item.get("provider"):
                providers.add(str(item["provider"]))
        return providers

    def _merge_tts(self, settings: Dict[str, Any], config: Dict[str, Any]) -> Dict[str, Any]:
        """
        合并 TTS 配置。

        Args:
            settings (Dict[str, Any]): settings 配置。
            config (Dict[str, Any]): 主配置。

        Returns:
            Dict[str, Any]: 合并后的 TTS 配置。

        Example:
        ```python
            settings={"api":{"tts":{"provider":"siliconflow"}}}
            config={"tts":{"providers":{"siliconflow":{"base_url":"https://api.siliconflow.cn/v1"}}}}
            => {"provider":"siliconflow","providers":{"siliconflow":{"base_url":"https://api.siliconflow.cn/v1"}}}
        ```
        """
        merged = copy.deepcopy(config.get("tts", {})) if isinstance(config.get("tts"), dict) else {}
        settings_tts = settings.get("api", {}).get("tts", {})
        if isinstance(settings_tts, dict):
            _deep_merge(merged, copy.deepcopy(settings_tts))
        if not isinstance(merged.get("providers"), dict):
            merged["providers"] = {}
        if not isinstance(merged.get("provider"), str) or not str(merged.get("provider")).strip():
            merged["provider"] = DEFAULT_TTS_PROVIDER
        return merged

    def _resolve_tts_keys(self, tts_cfg: Dict[str, Any]) -> Dict[str, Any]:
        """
        解析 TTS provider 密钥。

        Args:
            tts_cfg (Dict[str, Any]): TTS 配置。

        Returns:
            Dict[str, Any]: 解析后的配置。

        Example:
        ```
            tts_cfg={"provider":"siliconflow","providers":{"siliconflow":{"api_key_env":"SILICONFLOW_API_KEY"}}}
            => {"provider":"siliconflow","providers":{"siliconflow":{"api_key":"sk-live-siliconflow", ...}}}
        ```
        """
        resolved = copy.deepcopy(tts_cfg or {})
        providers = resolved.get("providers", {})
        if not isinstance(providers, dict):
            resolved["providers"] = {}
            return resolved
        for name, cfg in providers.items():
            if not isinstance(cfg, dict):
                continue
            new_cfg = copy.deepcopy(cfg)
            raw_key = str(new_cfg.get("api_key") or "").strip()
            if raw_key and not new_cfg.get("api_key_env") and looks_like_env_key_name(raw_key):
                new_cfg["api_key_env"] = raw_key
            resolved_key = resolve_provider_api_key(new_cfg)
            # 避免环境变量名直接返回到前端。
            if looks_like_env_key_name(resolved_key):
                resolved_key = ""
            new_cfg["api_key"] = resolved_key
            providers[name] = new_cfg
        resolved["providers"] = providers
        return resolved

    def _mask_tts(self, tts_cfg: Dict[str, Any]) -> Dict[str, Any]:
        """
        脱敏 TTS 配置中的密钥。

        Args:
            tts_cfg (Dict[str, Any]): TTS 配置。

        Returns:
            Dict[str, Any]: 脱敏后的配置。

        Example:
        ```
            _mask_tts({"providers":{"siliconflow":{"api_key":"sk-1234567890abcdef"}}})
            => {"providers":{"siliconflow":{"api_key":"sk-12345••••••••cdef"}}}
        ```
        """
        masked = copy.deepcopy(tts_cfg or {})
        providers = masked.get("providers", {})
        if not isinstance(providers, dict):
            masked["providers"] = {}
            return masked
        for cfg in providers.values():
            if isinstance(cfg, dict) and "api_key" in cfg:
                cfg["api_key"] = self._mask_key(str(cfg.get("api_key") or ""))
        return masked

    def _ensure_paths_defaults(self, settings: Dict[str, Any]) -> bool:
        """
        确保 settings 中存在 paths 默认值。

        Args:
            settings (Dict[str, Any]): settings 配置。

        Returns:
            bool: 是否发生变更。

        Example:
        ```
            settings={"paths":{"data_dir":"./data"}}
            => True（会补齐 audio_dir / log_dir / music_dir）
        ```
        """
        changed = False
        defaults = PathConfigModel().model_dump()
        paths_cfg = settings.get("paths")
        if not isinstance(paths_cfg, dict):
            settings["paths"] = defaults.copy()
            return True
        for key, default in defaults.items():
            if not str(paths_cfg.get(key) or "").strip():
                paths_cfg[key] = default
                changed = True
        settings["paths"] = paths_cfg
        return changed

    def _load_ui_settings(self, settings: Dict[str, Any]) -> Dict[str, Any]:
        """
        读取并规范化 UI 配置。

        Args:
            settings (Dict[str, Any]): settings 配置。

        Returns:
            Dict[str, Any]: UI 配置。

        Example:
        ```
            _load_ui_settings({"ui":{"theme":{"mode":"dark"}}})
            => {"theme":{"mode":"dark", ...},"font":{"family":"...", "size_scale":1.0, "weight":400}}
        ```
        """
        default_ui = UiConfigModel().model_dump()
        ui_cfg = settings.get("ui", {}) if isinstance(settings.get("ui"), dict) else {}
        theme = {
            **default_ui["theme"],
            **(ui_cfg.get("theme", {}) if isinstance(ui_cfg.get("theme"), dict) else {}),
        }
        font = {
            **default_ui["font"],
            **(ui_cfg.get("font", {}) if isinstance(ui_cfg.get("font"), dict) else {}),
        }
        return UiConfigModel(theme=UiThemeModel(**theme), font=UiFontModel(**font)).model_dump()

    def _save_ui_files(self, ui: Dict[str, Any]) -> None:
        """
        保存主题和字体配置到独立文件。

        Args:
            ui (Dict[str, Any]): UI 配置。

        Returns:
            None

        Example:
        ```
            _save_ui_files({"theme":{"mode":"light"}, "font":{"family":"Microsoft YaHei","size_scale":1.0,"weight":400}})
            => data/theme/theme.json 与 data/font/font.json 已更新
        ```
        """
        theme_file = self.paths.data_dir / "theme" / "theme.json"
        font_file = self.paths.data_dir / "font" / "font.json"
        theme_file.parent.mkdir(parents=True, exist_ok=True)
        font_file.parent.mkdir(parents=True, exist_ok=True)
        theme_file.write_text(
            json.dumps(ui.get("theme", {}), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        font_file.write_text(
            json.dumps(ui.get("font", {}), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _apply_env_updates(self, env_updates: Dict[str, str]) -> None:
        """
        应用环境变量更新到内存和 .env 文件。

        Args:
            env_updates (Dict[str, str]): 更新映射。

        Returns:
            None

        Example:
        ```
            _apply_env_updates({"OPENAI_API_KEY":"sk-new-openai"})
            => 进程环境和 .env 中的 OPENAI_API_KEY 均更新为 sk-new-openai
        ```
        """
        if not env_updates:
            return
        for key, value in env_updates.items():
            os.environ[key] = value
        merged = self._read_env_file()
        merged.update(env_updates)
        self._write_env_file(merged)

    def _reload_runtime_services(self, paths_changed: bool) -> None:
        """
        执行运行时重载。

        Args:
            paths_changed (bool): 路径是否变化。

        Returns:
            None

        Example:
        ```
            _reload_runtime_services(paths_changed=True)
            => 日志路径刷新、音乐服务重置、Agent 重载、TTS 服务重载
        ```
        """
        if paths_changed:
            try:
                logger.set_file_logging(True, str(self.paths.logs_dir))
            except Exception:
                pass
            try:
                from api.services.music_service import reset_music_service

                reset_music_service()
            except Exception:
                pass
        try:
            from agent.EmaAgent import get_agent

            get_agent().reload_config()
        except Exception:
            pass
        try:
            from api.services.tts_service import get_tts_service

            get_tts_service().reload_service()
        except Exception:
            pass

    async def get_settings(self) -> Dict[str, Any]:
        """
        获取完整设置。

        Args:
            None

        Returns:
            Dict[str, Any]: 前端配置。

        Example:
        ```
        => {
            "api": {"selected_model":"deepseek-chat", "provider_keys":{"openai":"sk-12345••••••••cdef"}, ...},
            "paths": {"data_dir":"./data", "audio_dir":"./data/audio/output", ...},
            "ui": {"theme":{"mode":"light", ...}, "font":{"family":"...", ...}}
        }
        ```
        """
        try:
            # 第 1 步：读取主配置与用户设置。
            config = self.paths.load_config()
            settings = self._load_settings()

            # 第 2 步：确保 paths 字段完整，缺失时自动补齐并回写。
            if self._ensure_paths_defaults(settings):
                self._save_settings(settings)

            # 第 3 步：解析当前选中模型和模型元数据。
            selected = self._resolve_selected_model(settings, config)
            selected_meta = self._resolve_selected_model_meta(config, selected)

            # 第 4 步：合并 TTS 配置，解析真实 key 后再做脱敏输出。
            tts_masked = self._mask_tts(self._resolve_tts_keys(self._merge_tts(settings, config)))
            tts_provider = str(tts_masked.get("provider") or DEFAULT_TTS_PROVIDER)
            tts_provider_cfg = (
                tts_masked.get("providers", {}).get(tts_provider, {})
                if isinstance(tts_masked.get("providers"), dict)
                else {}
            )

            # 第 5 步：收集各 provider 的 key，并统一脱敏给前端展示。
            provider_keys: Dict[str, str] = {}
            for provider in self._allowed_providers(config):
                env_name = PROVIDER_ENV_MAP.get(provider)
                if env_name:
                    provider_keys[provider] = self._mask_key(os.getenv(env_name, ""))

            # 第 6 步：构建 API 配置响应对象（包含旧字段兼容项）。
            api_cfg = settings.get("api", {}) if isinstance(settings.get("api"), dict) else {}
            api = ApiConfigModel(
                selected_model=selected,
                openai_api_key=self._mask_key(self._resolve_selected_model_key(selected_meta)),
                openai_base_url=selected_meta.get("base_url", "https://api.openai.com/v1"),
                openai_model=selected,
                provider_keys=provider_keys,
                silicon_api_key=self._mask_key(os.getenv("SILICONFLOW_API_KEY", "")),
                embeddings_api_key=self._mask_key(
                    os.getenv("EMBEDDINGS_API_KEY", "") or os.getenv("SILICONFLOW_API_KEY", "")
                ),
                embeddings_model=api_cfg.get(
                    "embeddings_model",
                    config.get("embeddings", {}).get("model", "Pro/BAAI/bge-m3"),
                ),
                embeddings_base_url=api_cfg.get(
                    "embeddings_base_url",
                    config.get("embeddings", {}).get("base_url", "https://api.siliconflow.cn/v1"),
                ),
                tts=tts_masked,
                tts_api_key=str(tts_provider_cfg.get("api_key", "")),
                tts_model=str(tts_provider_cfg.get("model", "")),
                tts_voice=str(tts_provider_cfg.get("voice", "")),
                temperature=float(api_cfg.get("temperature", config.get("llm", {}).get("temperature", 0.7))),
                max_tokens=int(api_cfg.get("max_tokens", config.get("llm", {}).get("max_tokens", 4096))),
                top_p=float(api_cfg.get("top_p", config.get("llm", {}).get("top_p", 1.0))),
                timeout=int(api_cfg.get("timeout", config.get("llm", {}).get("timeout", 60))),
            )

            # 第 7 步：构建路径配置响应对象。
            paths_cfg = settings.get("paths", {}) if isinstance(settings.get("paths"), dict) else {}
            path_model = PathConfigModel(
                data_dir=paths_cfg.get("data_dir", str(self.paths.data_dir)),
                audio_dir=paths_cfg.get("audio_dir", str(self.paths.audio_output_dir)),
                log_dir=paths_cfg.get("log_dir", str(self.paths.logs_dir)),
                music_dir=paths_cfg.get("music_dir", str(self.paths.music_dir)),
            )

            # 第 8 步：返回 settings 页所需的完整响应结构。
            return {
                "config": {
                    "llm": {
                        "provider": config.get("llm", {}).get("provider"),
                        "model": config.get("llm", {}).get("model"),
                        "base_url": config.get("llm", {}).get("base_url"),
                    },
                    "embeddings": {
                        "provider": config.get("embeddings", {}).get("provider"),
                        "model": config.get("embeddings", {}).get("model"),
                        "base_url": config.get("embeddings", {}).get("base_url"),
                    },
                    "tts": {
                        "provider": tts_masked.get("provider"),
                        "providers": tts_masked.get("providers", {}),
                    },
                },
                "api": api.model_dump(),
                "paths": path_model.model_dump(),
                "ui": self._load_ui_settings(settings),
            }
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to load settings: {exc}")

    async def update_settings(self, request: UpdateSettingsRequest) -> Dict[str, Any]:
        """
        更新设置。

        Args:
            request (UpdateSettingsRequest): 更新请求。

        Returns:
            Dict[str, Any]: 更新结果。

        Example:
        ```
            请求:
                {
                  "api": {
                    "selected_model": "gpt-4o",
                    "provider_keys": {"openai": "sk-new-openai"},
                    "embeddings_api_key": "sk-embed",
                    "tts": {"provider": "siliconflow", "providers": {"siliconflow": {"api_key": "sk-tts"}}}
                  }
                }
            返回:
                {"success": True, "message": "Settings updated successfully"}
        ```
        """
        try:
            # 第 1 步：读取当前配置与运行态上下文。
            settings = self._load_settings()
            config = self.paths.load_config()
            env_updates: Dict[str, str] = {}
            paths_changed = False

            if request.api:
                # 第 2 步：解析前端传入的 API 配置，并确定目标模型。
                incoming = request.api.model_dump()
                current_api = settings.get("api", {}) if isinstance(settings.get("api"), dict) else {}
                models = self._resolve_models(config)
                selected_model = str(
                    incoming.get("selected_model")
                    or current_api.get("selected_model")
                    or self._resolve_selected_model(settings, config)
                )
                if selected_model not in models and models:
                    selected_model = next(iter(models))
                selected_meta = self._resolve_selected_model_meta(config, selected_model)

                # 第 3 步：合并 provider_keys（忽略脱敏占位值）。
                allowed_providers = self._allowed_providers(config)
                provider_keys = (
                    copy.deepcopy(current_api.get("provider_keys", {}))
                    if isinstance(current_api.get("provider_keys"), dict)
                    else {}
                )
                incoming_keys = incoming.get("provider_keys", {})
                if isinstance(incoming_keys, dict):
                    for provider, value in incoming_keys.items():
                        if provider not in allowed_providers:
                            continue
                        normalized = self._normalize_secret(value)
                        if normalized is not None:
                            provider_keys[provider] = normalized
                selected_provider = str(selected_meta.get("provider") or "deepseek")
                selected_key = self._normalize_secret(incoming.get("openai_api_key"))
                if selected_key:
                    provider_keys[selected_provider] = selected_key

                # 第 4 步：将 provider_keys 转换为环境变量更新映射。
                for provider, value in provider_keys.items():
                    normalized = self._normalize_secret(value)
                    if not normalized:
                        continue
                    env_name = PROVIDER_ENV_MAP.get(provider)
                    if env_name:
                        env_updates[env_name] = normalized

                # 第 5 步：处理 embeddings/siliconflow 的密钥更新。
                embeddings_key = self._normalize_secret(incoming.get("embeddings_api_key"))
                if embeddings_key:
                    env_updates["EMBEDDINGS_API_KEY"] = embeddings_key
                silicon_key = self._normalize_secret(incoming.get("silicon_api_key"))
                if silicon_key:
                    env_updates["SILICONFLOW_API_KEY"] = silicon_key

                # 第 6 步：合并 TTS 配置，并把明文 key 转为 env 映射（settings 中仅保存 env 名）。
                current_tts = self._merge_tts(settings, config)
                incoming_tts = incoming.get("tts", {}) if isinstance(incoming.get("tts"), dict) else {}
                sanitized_tts = copy.deepcopy(incoming_tts)
                providers = sanitized_tts.get("providers", {})
                if isinstance(providers, dict):
                    for provider_name, provider_cfg in providers.items():
                        if not isinstance(provider_cfg, dict):
                            continue
                        raw_key = str(provider_cfg.get("api_key") or "").strip()
                        normalized = self._normalize_secret(raw_key, allow_not_required=True)
                        if normalized is None:
                            provider_cfg.pop("api_key", None)
                            if raw_key and looks_like_env_key_name(raw_key) and not provider_cfg.get("api_key_env"):
                                provider_cfg["api_key_env"] = raw_key
                        elif normalized == "NOT_REQUIRED":
                            provider_cfg["api_key"] = "NOT_REQUIRED"
                        else:
                            env_name = str(provider_cfg.get("api_key_env") or f"TTS_{provider_name.upper()}_API_KEY")
                            provider_cfg["api_key_env"] = env_name
                            provider_cfg["api_key"] = env_name
                            env_updates[env_name] = normalized
                next_tts = copy.deepcopy(current_tts)
                _deep_merge(next_tts, sanitized_tts)

                # 第 7 步：回写 settings.api 全量结构。
                settings["api"] = {
                    "selected_model": selected_model,
                    "openai_model": selected_model,
                    "openai_base_url": selected_meta.get("base_url", "https://api.openai.com/v1"),
                    "provider_keys": {k: v for k, v in provider_keys.items() if k in allowed_providers},
                    "embeddings_model": incoming.get(
                        "embeddings_model",
                        current_api.get("embeddings_model", "Pro/BAAI/bge-m3"),
                    ),
                    "embeddings_base_url": incoming.get(
                        "embeddings_base_url",
                        current_api.get("embeddings_base_url", "https://api.siliconflow.cn/v1"),
                    ),
                    "tts": next_tts,
                    "temperature": incoming.get("temperature", current_api.get("temperature", 0.7)),
                    "max_tokens": incoming.get("max_tokens", current_api.get("max_tokens", 4096)),
                    "top_p": incoming.get("top_p", current_api.get("top_p", 1.0)),
                    "timeout": incoming.get("timeout", current_api.get("timeout", 60)),
                }

            # 第 8 步：按需更新路径和 UI 配置。
            if request.paths:
                settings["paths"] = request.paths.model_dump()
                paths_changed = True
            if request.ui:
                ui = request.ui.model_dump()
                settings["ui"] = ui
                self._save_ui_files(ui)

            # 第 9 步：先落盘，再应用环境变量并触发服务热重载。
            self._save_settings(settings)
            self._apply_env_updates(env_updates)
            self._reload_runtime_services(paths_changed=paths_changed)
            return {"success": True, "message": "Settings updated successfully"}
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to update settings: {exc}")

    async def list_models(self) -> Dict[str, Any]:
        """
        获取模型列表。

        Args:
            None

        Returns:
            Dict[str, Any]: 模型列表结果。

        Example:
        ```
            => {
                 "selected_model": "deepseek-chat",
                 "models": [
                   {"id":"deepseek-chat","label":"DeepSeek Chat","provider":"deepseek","enabled":True}
                 ]
               }
        ```
        """
        try:
            config = self.paths.load_config()
            settings = self._load_settings()
            selected = self._resolve_selected_model(settings, config)
            models = self._resolve_models(config)
            result = []
            for model_id, info in models.items():
                provider = str(info.get("provider") or "")
                env_name = str(info.get("api_key_env") or PROVIDER_ENV_MAP.get(provider, "")).strip()
                key = os.getenv(env_name, "") if env_name else ""
                result.append(
                    {
                        "id": model_id,
                        "label": info.get("label", model_id),
                        "provider": provider,
                        "base_url": info.get("base_url", ""),
                        "api_key_env": env_name,
                        "enabled": bool(key and not key.lower().startswith("your_")),
                    }
                )
            return {"selected_model": selected, "models": result}
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to list models: {exc}")

    async def switch_model(self, request: SwitchModelRequest) -> Dict[str, Any]:
        """
        切换模型。

        Args:
            request (SwitchModelRequest): 模型切换请求。

        Returns:
            Dict[str, Any]: 切换结果。

        Example:
        ```
            请求:
                {"model":"gpt-4o"}
            返回:
                {"success": True, "selected_model": "gpt-4o"}
        ```
        """
        try:
            config = self.paths.load_config()
            models = self._resolve_models(config)
            if request.model not in models:
                raise HTTPException(status_code=400, detail=f"Unknown model: {request.model}")
            settings = self._load_settings()
            settings.setdefault("api", {})
            settings["api"]["selected_model"] = request.model
            settings["api"]["openai_model"] = request.model
            settings["api"]["openai_base_url"] = models[request.model].get("base_url", "https://api.openai.com/v1")
            self._save_settings(settings)
            self._reload_runtime_services(paths_changed=False)
            return {"success": True, "selected_model": request.model}
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to switch model: {exc}")

    async def get_paths_info(self) -> Dict[str, str]:
        """
        获取关键路径信息。

        Args:
            None

        Returns:
            Dict[str, str]: 路径信息。

        Example:
        ```
            => {
                 "root":"D:/Github/EmaAgent",
                 "sessions_dir":"D:/Github/EmaAgent/data/sessions",
                 "audio_output_dir":"D:/Github/EmaAgent/data/audio/output",
                 "narrative_dir":"D:/Github/EmaAgent/narrative",
                 "logs_dir":"D:/Github/EmaAgent/logs"
               }
        ```
        """
        return {
            "root": str(self.paths.root),
            "sessions_dir": str(self.paths.sessions_dir),
            "audio_output_dir": str(self.paths.audio_output_dir),
            "narrative_dir": str(self.paths.narrative_dir),
            "logs_dir": str(self.paths.logs_dir),
        }

    async def pick_directory(self, request: DirectoryPickerRequest) -> Dict[str, str]:
        """
        打开目录选择器。

        Args:
            request (DirectoryPickerRequest): 目录选择请求。

        Returns:
            Dict[str, str]: 选择结果。

        Example:
        ```
            返回:
                {"path":"D:/Data/MyMusic"}
        ```
        """
        try:
            import tkinter as tk
            from tkinter import filedialog

            initial = request.initial_dir or str(self.paths.root)
            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            selected = filedialog.askdirectory(
                title=request.title or "Select Directory",
                initialdir=initial,
                mustexist=False,
            )
            root.destroy()
            return {"path": selected or ""}
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to open directory picker: {exc}")

    async def get_system_status(self) -> SystemStatusResponse:
        """
        获取系统状态。

        Args:
            None

        Returns:
            SystemStatusResponse: 系统状态对象。

        Example:
        ```
            => {"backend":True,"websocket":True,"tts":True,"embeddings":True,"llm":True}
        ```
        """
        config = self.paths.load_config()
        settings = self._load_settings()
        selected = self._resolve_selected_model(settings, config)
        selected_meta = self._resolve_selected_model_meta(config, selected)
        llm_key = self._resolve_selected_model_key(selected_meta)
        llm_ready = bool(llm_key and not llm_key.lower().startswith("your_"))
        embeddings_key = os.getenv("EMBEDDINGS_API_KEY", "") or os.getenv("SILICONFLOW_API_KEY", "")
        embeddings_ready = bool(embeddings_key and not embeddings_key.lower().startswith("your_"))
        tts_cfg = self._resolve_tts_keys(self._merge_tts(settings, config))
        provider = str(tts_cfg.get("provider") or DEFAULT_TTS_PROVIDER)
        provider_cfg = (
            tts_cfg.get("providers", {}).get(provider, {})
            if isinstance(tts_cfg.get("providers"), dict)
            else {}
        )
        tts_key = str(provider_cfg.get("api_key") or "").strip()
        tts_ready = bool((tts_key and not tts_key.lower().startswith("your_")) or tts_key.lower() == "not_required")
        return SystemStatusResponse(
            backend=True,
            websocket=True,
            tts=tts_ready,
            embeddings=embeddings_ready,
            llm=llm_ready,
        )

    async def get_theme_settings(self) -> Dict[str, Any]:
        """
        获取主题配置。

        Args:
            None

        Returns:
            Dict[str, Any]: 主题配置。

        Example:
        ```
            => {"mode":"light","ema_rgb":[139,92,246],"accent_rgb":[59,130,246],"panel_rgb":[255,255,255],"panel_alpha":0.6}
        ```
        """
        settings = self._load_settings()
        return self._load_ui_settings(settings).get("theme", {})

    async def update_theme_settings(self, theme: UiThemeModel) -> Dict[str, Any]:
        """
        更新主题配置。

        Args:
            theme (UiThemeModel): 主题配置。

        Returns:
            Dict[str, Any]: 更新结果。

        Example:
        ```
            返回:
                {"success": True, "theme": {"mode":"dark","ema_rgb":[139,92,246],...}}
        ```
        """
        settings = self._load_settings()
        ui = self._load_ui_settings(settings)
        ui["theme"] = theme.model_dump()
        settings["ui"] = ui
        self._save_ui_files(ui)
        self._save_settings(settings)
        return {"success": True, "theme": ui["theme"]}

    async def get_font_settings(self) -> Dict[str, Any]:
        """
        获取字体配置。

        Args:
            None

        Returns:
            Dict[str, Any]: 字体配置。

        Example:
        ```
            => {"family":"'Microsoft YaHei', 'PingFang SC', sans-serif","size_scale":1.0,"weight":400}
        ```
        """
        settings = self._load_settings()
        return self._load_ui_settings(settings).get("font", {})

    async def update_font_settings(self, font: UiFontModel) -> Dict[str, Any]:
        """
        更新字体配置。

        Args:
            font (UiFontModel): 字体配置。

        Returns:
            Dict[str, Any]: 更新结果。

        Example:
        ```
            返回:
                {"success": True, "font": {"family":"Source Han Sans SC","size_scale":1.1,"weight":500}}
        ```
        """
        settings = self._load_settings()
        ui = self._load_ui_settings(settings)
        ui["font"] = font.model_dump()
        settings["ui"] = ui
        self._save_ui_files(ui)
        self._save_settings(settings)
        return {"success": True, "font": ui["font"]}

    async def get_tts_settings(self) -> Dict[str, Any]:
        """
        获取 TTS 设置。

        Args:
            None

        Returns:
            Dict[str, Any]: 脱敏后的 TTS 配置。

        Example:
        ```
            => {"provider":"siliconflow","providers":{"siliconflow":{"api_key":"SILICO••••••••_KEY","model":"FunAudioLLM/CosyVoice2-0.5B"}}}
        ```
        """
        settings = self._load_settings()
        config = self.paths.load_config()
        return self._mask_tts(self._resolve_tts_keys(self._merge_tts(settings, config)))

    async def switch_tts_provider(self, body: SwitchTtsProviderRequest) -> Dict[str, Any]:
        """
        切换 TTS Provider。

        Args:
            body (SwitchTtsProviderRequest): 切换请求体。

        Returns:
            Dict[str, Any]: 切换结果。

        Example:
        ```
            请求:
                {"provider":"vits_simple_api"}
            返回:
                {"success": True, "provider": "vits_simple_api"}
        ```
        """
        provider = str(body.provider or "").strip()
        if not provider:
            raise HTTPException(status_code=400, detail="provider required")
        settings = self._load_settings()
        config = self.paths.load_config()
        merged = self._merge_tts(settings, config)
        providers = merged.get("providers", {}) if isinstance(merged.get("providers"), dict) else {}
        if provider not in providers:
            raise HTTPException(status_code=400, detail=f"Unknown tts provider: {provider}")
        settings.setdefault("api", {})
        settings["api"].setdefault("tts", {})
        settings["api"]["tts"]["provider"] = provider
        self._save_settings(settings)
        try:
            from api.services.tts_service import get_tts_service

            get_tts_service().reload_service()
        except Exception:
            pass
        return {"success": True, "provider": provider}


_settings_service: Optional[SettingsService] = None


def get_settings_service() -> SettingsService:
    """
    获取设置服务单例。

    Args:
        None

    Returns:
        SettingsService: 设置服务实例。

    Example:
    ```
        get_settings_service()
        => <SettingsService object at 0x...>
    ```
    """
    global _settings_service
    if _settings_service is None:
        _settings_service = SettingsService()
    return _settings_service
