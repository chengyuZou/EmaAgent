# -*- coding: utf-8 -*-
"""设置服务（模块实现 + 薄调度）。"""

from __future__ import annotations

import copy
import json
import os
import re
from typing import Any, Dict, List, Optional

from fastapi import HTTPException

from api.routes.schemas.settings import (
    ApiConfigModel,
    DeleteMcpServerResponse,
    DirectoryPickerRequest,
    ImportMcpPasteRequest,
    PathConfigModel,
    SwitchModelRequest,
    SwitchTtsProviderRequest,
    SystemStatusResponse,
    UiFontModel,
    UiThemeModel,
    UpdateMcpServerEnvRequest,
    UpdateMcpServerEnvResponse,
    UpdateMcpSettingsRequest,
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
MASK_CHAR = "*"
MCP_ENV_VAR_PATTERN = re.compile(r"\$\{([^}]+)\}")
MCP_PASTE_KEY_CANDIDATES = ("mcp_servers", "mcpServers")
MCP_SERVER_HINT_KEYS = {"command", "args", "env", "enabled", "description", "cwd", "tools", "url", "transport"}
MCP_PLACEHOLDER_PATTERN = re.compile(r"^<[^>]+>$")


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


class SettingsRuntime:
    """
    设置运行时基础设施。

    负责底层读写与运行时刷新，不承载具体业务字段逻辑。
    """

    @property
    def paths(self):
        """
        获取路径配置管理器。
        """
        return get_paths()

    def load_settings(self) -> Dict[str, Any]:
        """
        读取 settings.json。
        """
        # 读取配置文件并兜底为字典结构。
        data = self.paths.load_settings()
        return data if isinstance(data, dict) else {}

    def save_settings(self, settings: Dict[str, Any]) -> None:
        """
        保存 settings.json。

        Args:
            settings (Dict[str, Any]): 待保存配置。
        """
        # 直接委托路径层持久化。
        self.paths.save_settings(settings)

    def _read_env_file(self) -> Dict[str, str]:
        """
        读取 `.env` 文件并解析为键值对。

        Returns:
            Dict[str, str]: 环境变量映射。

        Example:
        ```
            # .env:
            # OPENAI_API_KEY=sk-xxx
            runtime._read_env_file()
            => {"OPENAI_API_KEY": "sk-xxx"}
        ```
        """
        result: Dict[str, str] = {}
        # 获取 .env 路径，不存在时返回空映射。
        env_file = self.paths.env_file
        if not env_file.exists():
            return result

        # 逐行解析 key=value，跳过注释与空行。
        for raw_line in env_file.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            result[key.strip()] = value.strip().strip('"').strip("'")
        return result

    def _write_env_file(self, env_values: Dict[str, str]) -> None:
        """
        写入 `.env` 文件（更新已存在键并补充新键）。

        Args:
            env_values (Dict[str, str]): 待写入环境变量映射。

        Returns:
            None

        Example:
        ```
            runtime._write_env_file({"OPENAI_API_KEY": "sk-new", "NEW_VAR": "value"})
        ```
        """
        # 读取旧文件，按原顺序进行增量更新。
        env_file = self.paths.env_file
        old_lines = env_file.read_text(encoding="utf-8").splitlines() if env_file.exists() else []

        # 第一轮：替换旧键，保留注释与空行。
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

        # 第二轮：追加新增键。
        for key, value in env_values.items():
            if key not in consumed:
                new_lines.append(f"{key}={value}")

        # 最终写回，保证末尾换行。
        content = "\n".join(new_lines).strip()
        env_file.write_text((content + "\n") if content else "", encoding="utf-8")

    def apply_env_updates(self, env_updates: Dict[str, str]) -> None:
        """
        应用环境变量更新（进程内 + `.env`）。

        Args:
            env_updates (Dict[str, str]): 待更新环境变量映射。

        Returns:
            None

        Example:
        ```
            runtime.apply_env_updates({"OPENAI_API_KEY": "sk-new"})
        ```
        """
        if not env_updates:
            return

        # 先更新进程环境，保证本次请求内立即生效。
        for key, value in env_updates.items():
            os.environ[key] = value

        # 再持久化到 .env，保证重启后生效。
        merged = self._read_env_file()
        merged.update(env_updates)
        self._write_env_file(merged)

    def remove_env_keys(self, keys: List[str]) -> List[str]:
        """
        从 `.env` 中删除指定键，并同步清理当前进程环境变量。

        Args:
            keys (List[str]): 待删除键列表。

        Returns:
            List[str]: 实际删除的键列表（去重后）。
        """
        target_keys = {str(item or "").strip() for item in keys if str(item or "").strip()}
        if not target_keys:
            return []

        for key in target_keys:
            os.environ.pop(key, None)

        env_file = self.paths.env_file
        if not env_file.exists():
            return []

        new_lines: List[str] = []
        removed: List[str] = []
        for raw_line in env_file.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                new_lines.append(raw_line)
                continue
            key, _ = line.split("=", 1)
            key = key.strip()
            if key in target_keys:
                removed.append(key)
                continue
            new_lines.append(raw_line)

        content = "\n".join(new_lines).strip()
        env_file.write_text((content + "\n") if content else "", encoding="utf-8")
        return sorted(set(removed))

    def save_ui_files(self, ui: Dict[str, Any]) -> None:
        """
        保存 UI 配置到独立文件（theme/font）。

        Args:
            ui (Dict[str, Any]): UI 配置字典。
        """
        # 计算主题与字体文件路径并确保目录存在。
        theme_file = self.paths.theme_file
        font_file = self.paths.font_file
        theme_file.parent.mkdir(parents=True, exist_ok=True)
        font_file.parent.mkdir(parents=True, exist_ok=True)

        # 分别写入 theme.json / font.json。
        theme_file.write_text(json.dumps(ui.get("theme", {}), ensure_ascii=False, indent=2), encoding="utf-8")
        font_file.write_text(json.dumps(ui.get("font", {}), ensure_ascii=False, indent=2), encoding="utf-8")

    def reload_runtime_services(self, paths_changed: bool) -> None:
        """
        根据配置变化刷新运行时服务。

        Args:
            paths_changed (bool): 路径是否发生变化。
        """
        if paths_changed:
            # 路径变化时，先刷新日志与音乐服务。
            try:
                logger.set_file_logging(True, str(self.paths.logs_dir))
            except Exception:
                pass

            try:
                from api.services.music_service import reset_music_service

                reset_music_service()
            except Exception:
                pass

        # 无论是否路径变化，都尝试刷新 Agent 与 TTS。
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

    async def reload_agent_with_mcp(self) -> None:
        """
        异步重载 Agent，并重新挂载 MCP 工具。

        Returns:
            None
        """
        try:
            from agent.EmaAgent import get_agent

            await get_agent().reload_config_async(reload_mcp=True)
        except Exception as exc:
            logger.warning(f"[SettingsRuntime] 重载 Agent/MCP 失败: {exc}")

    def load_mcp_file(self) -> Dict[str, Any]:
        """
        读取 mcp.json，并保证返回结构可用。

        Returns:
            Dict[str, Any]: MCP 配置字典，至少包含 `mcp_servers`。

        Example:
        ```
            runtime.load_mcp_file()
            => {"mcp_servers": {...}}
        ```
        """
        try:
            data = self.paths.load_mcp_config()
        except FileNotFoundError:
            return {"mcp_servers": {}}

        # 统一兜底为标准结构。
        if not isinstance(data, dict):
            return {"mcp_servers": {}}
        if not isinstance(data.get("mcp_servers"), dict):
            data["mcp_servers"] = {}
        return data

    def save_mcp_file(self, data: Dict[str, Any]) -> None:
        """
        保存 mcp.json。

        Args:
            data (Dict[str, Any]): 待保存 MCP 配置。

        Example:
        ```
            runtime.save_mcp_file({"mcp_servers": {"amap": {"enabled": true}}})
        ```
        """
        # 确保配置目录存在后再写入。
        self.paths.mcp_json.parent.mkdir(parents=True, exist_ok=True)
        self.paths.mcp_json.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


class UiSettingsSupport:
    """
    UI 配置公共支持组件。

    负责 `ui.theme` 与 `ui.font` 的标准化读取和分区写回。
    """

    def __init__(self, runtime: SettingsRuntime) -> None:
        """
        初始化 UI 公共支持组件。

        Args:
            runtime (SettingsRuntime): 运行时基础设施实例。
        """
        self.runtime = runtime

    def load_ui_settings(self, settings: Dict[str, Any]) -> Dict[str, Any]:
        """
        读取并标准化 UI 配置。

        Args:
            settings (Dict[str, Any]): settings 配置字典。

        Returns:
            Dict[str, Any]: 标准化后的 `{"theme": ..., "font": ...}`。

        Example:
        ```
            ui_support.load_ui_settings({"ui": {"theme": {"mode": "dark"}}})
            => {"theme": {...完整字段...}, "font": {...默认字段...}}
        ```
        """
        # 构建主题与字体默认值。
        default_theme = UiThemeModel().model_dump()
        default_font = UiFontModel().model_dump()

        # 从 settings 中读取 ui 块并进行字典合并。
        ui_cfg = settings.get("ui", {}) if isinstance(settings.get("ui"), dict) else {}
        theme = {**default_theme, **(ui_cfg.get("theme", {}) if isinstance(ui_cfg.get("theme"), dict) else {})}
        font = {**default_font, **(ui_cfg.get("font", {}) if isinstance(ui_cfg.get("font"), dict) else {})}

        # 使用 Pydantic 二次校验并返回标准结构。
        return {
            "theme": UiThemeModel(**theme).model_dump(),
            "font": UiFontModel(**font).model_dump(),
        }

    def read_section(self, section: str) -> Dict[str, Any]:
        """
        读取 UI 分区配置。

        Args:
            section (str): 分区名，通常为 `theme` 或 `font`。

        Returns:
            Dict[str, Any]: 对应分区配置；不存在时返回空字典。

        Example:
        ```
            ui_support.read_section("theme")
            => {"mode": "light", "ema_rgb": [139, 92, 246], ...}
        ```
        """
        # 读取并标准化 UI 后，返回指定分区。
        settings = self.runtime.load_settings()
        ui = self.load_ui_settings(settings)
        return ui.get(section, {})

    def update_section(self, section: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        更新 UI 分区配置并持久化。

        Args:
            section (str): 分区名，通常为 `theme` 或 `font`。
            payload (Dict[str, Any]): 分区新配置。

        Returns:
            Dict[str, Any]: 更新结果。

        Example:
        ```
            ui_support.update_section("font", {"family": "Microsoft YaHei", "size_scale": 1.0, "weight": 400})
            => {"success": True, "font": {...}}
        ```
        """
        # 先加载现有配置并替换指定分区。
        settings = self.runtime.load_settings()
        ui = self.load_ui_settings(settings)
        ui[section] = payload
        settings["ui"] = ui

        # 同步写回 settings.json 与独立 UI 文件。
        self.runtime.save_ui_files(ui)
        self.runtime.save_settings(settings)
        return {"success": True, section: ui[section]}


class ApiSettingsModule:
    """
    API 配置模块。

    负责 LLM/Embedding/TTS/模型切换相关逻辑。
    """

    def __init__(self, runtime: SettingsRuntime) -> None:
        """
        初始化 API 配置模块。

        Args:
            runtime (SettingsRuntime): 运行时基础设施实例。
        """
        self.runtime = runtime

    def _is_masked_value(self, value: Any) -> bool:
        """
        判断输入值是否为脱敏占位。

        Args:
            value (Any): 待判断值。

        Returns:
            bool: 是否为脱敏占位值。

        Example:
        ```
            _is_masked_value("SILICON********KEY")
            => True
        ```
        """
        # 统一转字符串并去除首尾空白。
        raw = str(value or "").strip()
        return bool(raw and (MASK_CHAR in raw or "*" in raw))

    def _normalize_secret(self, value: Any, allow_not_required: bool = False) -> Optional[str]:
        """
        标准化密钥输入。

        Args:
            value (Any): 原始密钥输入。
            allow_not_required (bool): 是否允许 `NOT_REQUIRED` 作为有效值。

        Returns:
            Optional[str]: 可写入密钥；若应忽略本次输入则返回 None。

        Example:
        ```
            _normalize_secret("********")
            => None
            _normalize_secret("sk-live")
            => "sk-live"
        ```
        """
        # 空值、脱敏值、env 变量名都视为“忽略本次更新”。
        raw = str(value or "").strip()
        if not raw or self._is_masked_value(raw) or looks_like_env_key_name(raw):
            return None
        if allow_not_required and raw.lower() == "not_required":
            return "NOT_REQUIRED"
        return raw

    def _resolve_models(self, config: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
        """
        提取模型映射。

        Args:
            config (Dict[str, Any]): 主配置对象。

        Returns:
            Dict[str, Dict[str, Any]]: `llm_models` 映射。

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
            settings (Dict[str, Any]): settings 配置对象。
            config (Dict[str, Any]): 主配置对象。

        Returns:
            str: 当前模型 ID。

        Example:
        ```
            _resolve_selected_model({"api": {"selected_model": "gpt-4o"}}, {"llm": {"model": "deepseek-chat"}})
            => "gpt-4o"
        ```
        """
        # 优先级：settings.api.selected_model > settings.api.openai_model > config.llm.model > 默认值。
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
        获取选中模型的元数据配置。

        Args:
            config (Dict[str, Any]): 主配置对象。
            selected_model (str): 模型 ID。

        Returns:
            Dict[str, Any]: 模型元数据。
        """
        return self._resolve_models(config).get(selected_model, {})

    def _resolve_selected_model_key(self, selected_model_meta: Dict[str, Any]) -> str:
        """
        根据模型元数据解析实际 API Key。

        Args:
            selected_model_meta (Dict[str, Any]): 选中模型元数据。

        Returns:
            str: 解析后的真实密钥；若不存在则为空字符串。
        """
        # 从 `api_key_env` 读取环境变量，返回真实 key。
        env_name = str(selected_model_meta.get("api_key_env") or "").strip()
        return os.getenv(env_name, "") if env_name else ""

    def _allowed_providers(self, config: Dict[str, Any]) -> set[str]:
        """
        计算允许使用的 provider 集合。

        Args:
            config (Dict[str, Any]): 主配置对象。

        Returns:
            set[str]: provider 集合。
        """
        # 基础 provider 来自固定映射。
        providers = set(PROVIDER_ENV_MAP.keys())
        # 额外 provider 从 llm_models 动态提取。
        for item in self._resolve_models(config).values():
            if isinstance(item, dict) and item.get("provider"):
                providers.add(str(item["provider"]))
        return providers

    def _merge_tts(self, settings: Dict[str, Any], config: Dict[str, Any]) -> Dict[str, Any]:
        """
        合并 TTS 配置（config 基础 + settings 覆盖）。

        Args:
            settings (Dict[str, Any]): settings 配置对象。
            config (Dict[str, Any]): 主配置对象。

        Returns:
            Dict[str, Any]: 合并后的 TTS 配置对象。
        """
        # 先复制 config.tts，避免原配置被原地污染。
        merged = copy.deepcopy(config.get("tts", {})) if isinstance(config.get("tts"), dict) else {}

        # 再叠加 settings.api.tts。
        settings_tts = settings.get("api", {}).get("tts", {})
        if isinstance(settings_tts, dict):
            _deep_merge(merged, copy.deepcopy(settings_tts))

        # 结构兜底。
        if not isinstance(merged.get("providers"), dict):
            merged["providers"] = {}
        if not isinstance(merged.get("provider"), str) or not str(merged.get("provider")).strip():
            merged["provider"] = DEFAULT_TTS_PROVIDER
        return merged

    def _resolve_tts_keys(self, tts_cfg: Dict[str, Any]) -> Dict[str, Any]:
        """
        将 TTS provider 的密钥字段解析为可用明文。

        Args:
            tts_cfg (Dict[str, Any]): TTS 配置对象。

        Returns:
            Dict[str, Any]: 解析后的 TTS 配置对象。
        """
        resolved = copy.deepcopy(tts_cfg or {})
        providers = resolved.get("providers", {})
        if not isinstance(providers, dict):
            resolved["providers"] = {}
            return resolved

        # 逐个 provider 解析 api_key / api_key_env。
        for name, cfg in providers.items():
            if not isinstance(cfg, dict):
                continue
            new_cfg = copy.deepcopy(cfg)
            raw_key = str(new_cfg.get("api_key") or "").strip()
            if raw_key and not new_cfg.get("api_key_env") and looks_like_env_key_name(raw_key):
                new_cfg["api_key_env"] = raw_key
            resolved_key = resolve_provider_api_key(new_cfg)
            if looks_like_env_key_name(resolved_key):
                resolved_key = ""
            new_cfg["api_key"] = resolved_key
            providers[name] = new_cfg
        resolved["providers"] = providers
        return resolved

    def _sanitize_tts_update(self, incoming_tts: Dict[str, Any], env_updates: Dict[str, str]) -> Dict[str, Any]:
        """
        清洗前端传入的 TTS 更新对象并收集 env 更新项。

        Args:
            incoming_tts (Dict[str, Any]): 前端传入的 TTS 配置。
            env_updates (Dict[str, str]): 待写入环境变量映射（输出参数）。

        Returns:
            Dict[str, Any]: 清洗后的 TTS 配置。
        """
        sanitized_tts = copy.deepcopy(incoming_tts)
        providers = sanitized_tts.get("providers", {})
        if not isinstance(providers, dict):
            return sanitized_tts

        # 逐个 provider 清洗 key。
        for provider_name, provider_cfg in providers.items():
            if not isinstance(provider_cfg, dict):
                continue
            raw_key = str(provider_cfg.get("api_key") or "").strip()
            normalized = self._normalize_secret(raw_key, allow_not_required=True)
            if normalized is None:
                provider_cfg.pop("api_key", None)
                if raw_key and looks_like_env_key_name(raw_key) and not provider_cfg.get("api_key_env"):
                    provider_cfg["api_key_env"] = raw_key
                continue
            if normalized == "NOT_REQUIRED":
                provider_cfg["api_key"] = "NOT_REQUIRED"
                continue

            # 明文 key 不直接落 settings，而是转成 env 引用。
            env_name = str(provider_cfg.get("api_key_env") or f"TTS_{provider_name.upper()}_API_KEY")
            provider_cfg["api_key_env"] = env_name
            provider_cfg["api_key"] = env_name
            env_updates[env_name] = normalized
        return sanitized_tts

    def apply_update_to_settings(
        self,
        settings: Dict[str, Any],
        config: Dict[str, Any],
        incoming: Dict[str, Any],
        env_updates: Dict[str, str],
    ) -> None:
        """
        将 API 更新应用到 settings 对象。

        Args:
            settings (Dict[str, Any]): 待更新 settings 对象。
            config (Dict[str, Any]): 主配置对象。
            incoming (Dict[str, Any]): 前端 API 更新 payload。
            env_updates (Dict[str, str]): 待写入环境变量映射（输出参数）。

        Returns:
            None

        Example:
        ```
            env_updates = {}
            apply_update_to_settings(settings, config, incoming, env_updates)
            => settings["api"] 已更新，env_updates 收集了待写入项
        ```
        """
        current_api = settings.get("api", {}) if isinstance(settings.get("api"), dict) else {}

        # 1) 解析选中模型与模型元数据。
        models = self._resolve_models(config)
        selected_model = str(
            incoming.get("selected_model")
            or current_api.get("selected_model")
            or self._resolve_selected_model(settings, config)
        )
        if selected_model not in models and models:
            selected_model = next(iter(models))
        selected_meta = self._resolve_selected_model_meta(config, selected_model)

        # 2) 合并 provider_keys。
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

        # 3) provider key / embeddings key / silicon key -> env_updates。
        for provider, value in provider_keys.items():
            normalized = self._normalize_secret(value)
            if not normalized:
                continue
            env_name = PROVIDER_ENV_MAP.get(provider)
            if env_name:
                env_updates[env_name] = normalized

        embeddings_key = self._normalize_secret(incoming.get("embeddings_api_key"))
        if embeddings_key:
            env_updates["EMBEDDINGS_API_KEY"] = embeddings_key
        silicon_key = self._normalize_secret(incoming.get("silicon_api_key"))
        if silicon_key:
            env_updates["SILICONFLOW_API_KEY"] = silicon_key

        # 4) 清洗并合并 TTS 配置。
        current_tts = self._merge_tts(settings, config)
        incoming_tts = incoming.get("tts", {}) if isinstance(incoming.get("tts"), dict) else {}
        sanitized_tts = self._sanitize_tts_update(incoming_tts, env_updates)
        next_tts = copy.deepcopy(current_tts)
        _deep_merge(next_tts, sanitized_tts)

        # 5) 回写 settings["api"]。
        settings["api"] = {
            "selected_model": selected_model,
            "openai_model": selected_model,
            "openai_base_url": selected_meta.get("base_url", "https://api.openai.com/v1"),
            "provider_keys": {k: v for k, v in provider_keys.items() if k in allowed_providers},
            "embeddings_model": incoming.get("embeddings_model", current_api.get("embeddings_model", "Pro/BAAI/bge-m3")),
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

    def build_api_config(self, settings: Dict[str, Any], config: Dict[str, Any]) -> ApiConfigModel:
        """
        构建返回前端的 API 配置模型。

        Args:
            settings (Dict[str, Any]): settings 配置对象。
            config (Dict[str, Any]): 主配置对象。

        Returns:
            ApiConfigModel: 组装后的 API 配置模型。
        """
        selected = self._resolve_selected_model(settings, config)
        selected_meta = self._resolve_selected_model_meta(config, selected)
        tts_resolved = self._resolve_tts_keys(self._merge_tts(settings, config))
        tts_provider = str(tts_resolved.get("provider") or DEFAULT_TTS_PROVIDER)
        tts_provider_cfg = (
            tts_resolved.get("providers", {}).get(tts_provider, {})
            if isinstance(tts_resolved.get("providers"), dict)
            else {}
        )
        provider_keys: Dict[str, str] = {}
        # 从 provider-env 映射读取当前有效 key。
        for provider in self._allowed_providers(config):
            env_name = PROVIDER_ENV_MAP.get(provider)
            if env_name:
                provider_keys[provider] = os.getenv(env_name, "")
        api_cfg = settings.get("api", {}) if isinstance(settings.get("api"), dict) else {}
        return ApiConfigModel(
            selected_model=selected,
            openai_api_key=self._resolve_selected_model_key(selected_meta),
            openai_base_url=selected_meta.get("base_url", "https://api.openai.com/v1"),
            openai_model=selected,
            provider_keys=provider_keys,
            silicon_api_key=os.getenv("SILICONFLOW_API_KEY", ""),
            embeddings_api_key=(os.getenv("EMBEDDINGS_API_KEY", "") or os.getenv("SILICONFLOW_API_KEY", "")),
            embeddings_model=api_cfg.get("embeddings_model", config.get("embeddings", {}).get("model", "Pro/BAAI/bge-m3")),
            embeddings_base_url=api_cfg.get(
                "embeddings_base_url",
                config.get("embeddings", {}).get("base_url", "https://api.siliconflow.cn/v1"),
            ),
            tts=tts_resolved,
            tts_api_key=str(tts_provider_cfg.get("api_key", "")),
            tts_model=str(tts_provider_cfg.get("model", "")),
            tts_voice=str(tts_provider_cfg.get("voice", "")),
            temperature=float(api_cfg.get("temperature", config.get("llm", {}).get("temperature", 0.7))),
            max_tokens=int(api_cfg.get("max_tokens", config.get("llm", {}).get("max_tokens", 4096))),
            top_p=float(api_cfg.get("top_p", config.get("llm", {}).get("top_p", 1.0))),
            timeout=int(api_cfg.get("timeout", config.get("llm", {}).get("timeout", 60))),
        )

    def get(self, settings: Optional[Dict[str, Any]] = None, config: Optional[Dict[str, Any]] = None) -> ApiConfigModel:
        """
        获取 API 配置模型。

        Args:
            settings (Optional[Dict[str, Any]]): 可选 settings 对象。
            config (Optional[Dict[str, Any]]): 可选主配置对象。

        Returns:
            ApiConfigModel: API 配置模型。
        """
        real_settings = settings if settings is not None else self.runtime.load_settings()
        real_config = config if config is not None else self.runtime.paths.load_config()
        return self.build_api_config(real_settings, real_config)

    def update(self, api: ApiConfigModel) -> Dict[str, Any]:
        """
        更新 API 分区配置。

        Args:
            api (ApiConfigModel): API 更新请求模型。

        Returns:
            Dict[str, Any]: 更新结果。
        """
        settings = self.runtime.load_settings()
        config = self.runtime.paths.load_config()

        # 先收集更新，再统一写盘与刷新。
        env_updates: Dict[str, str] = {}
        self.apply_update_to_settings(settings, config, api.model_dump(), env_updates)
        self.runtime.save_settings(settings)
        self.runtime.apply_env_updates(env_updates)
        self.runtime.reload_runtime_services(paths_changed=False)
        return {"success": True, "message": "API settings updated successfully"}

    def list_models(self) -> Dict[str, Any]:
        """
        列出模型清单及可用状态。

        Args:
            None

        Returns:
            Dict[str, Any]: 包含 `selected_model` 与 `models` 的字典。
        """
        config = self.runtime.paths.load_config()
        settings = self.runtime.load_settings()
        selected = self._resolve_selected_model(settings, config)
        models = self._resolve_models(config)
        result = []
        # 遍历模型并计算 enabled 状态。
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

    def switch_model(self, request: SwitchModelRequest) -> Dict[str, Any]:
        """
        切换当前模型。

        Args:
            request (SwitchModelRequest): 模型切换请求。

        Returns:
            Dict[str, Any]: 切换结果。
        """
        config = self.runtime.paths.load_config()
        models = self._resolve_models(config)
        if request.model not in models:
            raise HTTPException(status_code=400, detail=f"Unknown model: {request.model}")

        # 回写 settings 中模型相关字段。
        settings = self.runtime.load_settings()
        settings.setdefault("api", {})
        settings["api"]["selected_model"] = request.model
        settings["api"]["openai_model"] = request.model
        settings["api"]["openai_base_url"] = models[request.model].get("base_url", "https://api.openai.com/v1")
        self.runtime.save_settings(settings)
        self.runtime.reload_runtime_services(paths_changed=False)
        return {"success": True, "selected_model": request.model}

    def get_tts_settings(self) -> Dict[str, Any]:
        """
        获取 TTS 配置（含密钥解析）。

        Args:
            None

        Returns:
            Dict[str, Any]: TTS 配置字典。
        """
        settings = self.runtime.load_settings()
        config = self.runtime.paths.load_config()
        return self._resolve_tts_keys(self._merge_tts(settings, config))

    def switch_tts_provider(self, body: SwitchTtsProviderRequest) -> Dict[str, Any]:
        """
        切换当前 TTS Provider。

        Args:
            body (SwitchTtsProviderRequest): Provider 切换请求。

        Returns:
            Dict[str, Any]: 切换结果。
        """
        provider = str(body.provider or "").strip()
        if not provider:
            raise HTTPException(status_code=400, detail="provider required")
        settings = self.runtime.load_settings()
        config = self.runtime.paths.load_config()
        merged = self._merge_tts(settings, config)
        providers = merged.get("providers", {}) if isinstance(merged.get("providers"), dict) else {}
        if provider not in providers:
            raise HTTPException(status_code=400, detail=f"Unknown tts provider: {provider}")

        # 保存当前激活 provider。
        settings.setdefault("api", {})
        settings["api"].setdefault("tts", {})
        settings["api"]["tts"]["provider"] = provider
        self.runtime.save_settings(settings)

        # 尝试热刷新 TTS 服务。
        try:
            from api.services.tts_service import get_tts_service

            get_tts_service().reload_service()
        except Exception:
            pass
        return {"success": True, "provider": provider}

    def get_system_status(self) -> SystemStatusResponse:
        """
        计算系统状态（后端/WebSocket/LLM/Embedding/TTS）。

        Args:
            None

        Returns:
            SystemStatusResponse: 系统状态对象。
        """
        config = self.runtime.paths.load_config()
        settings = self.runtime.load_settings()

        # LLM 状态。
        selected = self._resolve_selected_model(settings, config)
        selected_meta = self._resolve_selected_model_meta(config, selected)
        llm_key = self._resolve_selected_model_key(selected_meta)
        llm_ready = bool(llm_key and not llm_key.lower().startswith("your_"))

        # Embedding 状态。
        embeddings_key = os.getenv("EMBEDDINGS_API_KEY", "") or os.getenv("SILICONFLOW_API_KEY", "")
        embeddings_ready = bool(embeddings_key and not embeddings_key.lower().startswith("your_"))

        # TTS 状态。
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


class PathSettingsModule:
    """
    路径配置模块。

    负责路径分区的读取、更新与目录选择器能力。
    """

    def __init__(self, runtime: SettingsRuntime) -> None:
        """
        初始化路径配置模块。

        Args:
            runtime (SettingsRuntime): 运行时基础设施实例。

        Returns:
            None
        """
        self.runtime = runtime

    def build_paths_config(self, settings: Dict[str, Any]) -> PathConfigModel:
        """
        构建路径配置模型。

        Args:
            settings (Dict[str, Any]): settings 配置对象。

        Returns:
            PathConfigModel: 路径配置模型。
        """
        paths_cfg = settings.get("paths", {}) if isinstance(settings.get("paths"), dict) else {}
        return PathConfigModel(
            data_dir=paths_cfg.get("data_dir", str(self.runtime.paths.data_dir)),
            audio_dir=paths_cfg.get("audio_dir", str(self.runtime.paths.audio_output_dir)),
            log_dir=paths_cfg.get("log_dir", str(self.runtime.paths.logs_dir)),
            music_dir=paths_cfg.get("music_dir", str(self.runtime.paths.music_dir)),
        )

    def get(self, settings: Optional[Dict[str, Any]] = None) -> PathConfigModel:
        """
        获取路径配置模型。

        Args:
            settings (Optional[Dict[str, Any]]): 可选 settings 对象。

        Returns:
            PathConfigModel: 路径配置模型。
        """
        real_settings = settings if settings is not None else self.runtime.load_settings()
        return self.build_paths_config(real_settings)

    def update(self, paths: PathConfigModel) -> Dict[str, Any]:
        """
        更新路径分区配置。

        Args:
            paths (PathConfigModel): 新路径配置模型。

        Returns:
            Dict[str, Any]: 更新结果。
        """
        # 回写 settings.paths 并触发路径相关热刷新。
        settings = self.runtime.load_settings()
        settings["paths"] = paths.model_dump()
        self.runtime.save_settings(settings)
        self.runtime.reload_runtime_services(paths_changed=True)
        return {"success": True, "message": "Path settings updated successfully"}

    def get_paths_info(self) -> Dict[str, str]:
        """
        获取关键路径信息。

        Args:
            None

        Returns:
            Dict[str, str]: 根目录与业务目录路径信息。
        """
        return {
            "root": str(self.runtime.paths.root),
            "sessions_dir": str(self.runtime.paths.sessions_dir),
            "audio_output_dir": str(self.runtime.paths.audio_output_dir),
            "narrative_dir": str(self.runtime.paths.narrative_dir),
            "logs_dir": str(self.runtime.paths.logs_dir),
        }

    def pick_directory(self, request: DirectoryPickerRequest) -> Dict[str, str]:
        """
        打开系统目录选择器并返回所选路径。

        Args:
            request (DirectoryPickerRequest): 目录选择请求。

        Returns:
            Dict[str, str]: `{"path": "..."}` 结构。
        """
        try:
            import tkinter as tk
            from tkinter import filedialog

            # 置顶目录选择窗口，减少被遮挡问题。
            initial = request.initial_dir or str(self.runtime.paths.root)
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


class ThemeSettingsModule:
    """
    主题配置模块。

    负责 `ui.theme` 分区读写。
    """

    def __init__(self, ui_support: UiSettingsSupport) -> None:
        """
        初始化主题配置模块。

        Args:
            ui_support (UiSettingsSupport): UI 公共支持实例。

        Returns:
            None
        """
        self.ui_support = ui_support

    def get(self) -> Dict[str, Any]:
        """
        读取主题配置。

        Args:
            None

        Returns:
            Dict[str, Any]: 主题配置字典。
        """
        return self.ui_support.read_section("theme")

    def update(self, theme: UiThemeModel) -> Dict[str, Any]:
        """
        更新主题配置。

        Args:
            theme (UiThemeModel): 主题配置模型。

        Returns:
            Dict[str, Any]: 更新结果。
        """
        return self.ui_support.update_section("theme", theme.model_dump())


class FontSettingsModule:
    """
    字体配置模块。

    负责 `ui.font` 分区读写。
    """

    def __init__(self, ui_support: UiSettingsSupport) -> None:
        """
        初始化字体配置模块。

        Args:
            ui_support (UiSettingsSupport): UI 公共支持实例。

        Returns:
            None
        """
        self.ui_support = ui_support

    def get(self) -> Dict[str, Any]:
        """
        读取字体配置。

        Args:
            None

        Returns:
            Dict[str, Any]: 字体配置字典。
        """
        return self.ui_support.read_section("font")

    def update(self, font: UiFontModel) -> Dict[str, Any]:
        """
        更新字体配置。

        Args:
            font (UiFontModel): 字体配置模型。

        Returns:
            Dict[str, Any]: 更新结果。
        """
        return self.ui_support.update_section("font", font.model_dump())


class McpSettingsModule:
    """
    MCP 配置模块。

    负责 MCP 配置规范化、元数据构建、读写持久化。
    """

    def __init__(self, runtime: SettingsRuntime) -> None:
        """
        初始化 MCP 配置模块。

        Args:
            runtime (SettingsRuntime): 运行时基础设施实例。

        Returns:
            None
        """
        self.runtime = runtime

    def _normalize_mcp_servers(self, mcp_servers: Any) -> Dict[str, Dict[str, Any]]:
        """
        规范化 `mcp_servers` 字段。

        Args:
            mcp_servers (Any): 原始 `mcp_servers` 值。

        Returns:
            Dict[str, Dict[str, Any]]: 规范化结果。
        """
        if not isinstance(mcp_servers, dict):
            return {}
        normalized: Dict[str, Dict[str, Any]] = {}
        for server_name, server_cfg in mcp_servers.items():
            name = str(server_name).strip()
            if not name:
                continue
            normalized[name] = copy.deepcopy(server_cfg) if isinstance(server_cfg, dict) else {}
        return normalized

    def _normalize_tool_list(self, tools: Any) -> List[str]:
        """
        规范化工具列表为字符串数组。

        Args:
            tools (Any): 原始 tools 字段。

        Returns:
            List[str]: 工具名列表。
        """
        if not isinstance(tools, list):
            return []
        result: List[str] = []
        for item in tools:
            if isinstance(item, str) and item.strip():
                result.append(item.strip())
            elif isinstance(item, dict):
                name = str(item.get("name") or "").strip()
                if name:
                    result.append(name)
        return result

    def _runtime_mcp_tool_map(self) -> Dict[str, List[str]]:
        """
        从运行时 MCP 管理器读取工具映射。

        Args:
            None

        Returns:
            Dict[str, List[str]]: `{server_name: [tool_name, ...]}`。
        """
        try:
            import agent.EmaAgent as ema_agent_module

            agent = getattr(ema_agent_module, "_ema_agent", None)
            manager = getattr(agent, "mcp_manager", None) if agent else None
            clients = manager.clients if manager else {}
            result: Dict[str, List[str]] = {}
            for server_name, client in clients.items():
                tools = self._normalize_tool_list(getattr(client, "tools", []))
                if tools:
                    result[server_name] = tools
            return result
        except Exception:
            return {}

    def _parse_mcp_required_keys(self, env_cfg: Dict[str, Any]) -> List[Dict[str, str]]:
        """
        解析 MCP `env` 字段并生成 required_keys 元数据。

        Args:
            env_cfg (Dict[str, Any]): MCP server 的 env 配置。

        Returns:
            List[Dict[str, str]]: required_keys 列表。
        """
        result: List[Dict[str, str]] = []
        if not isinstance(env_cfg, dict):
            return result
        for config_key, raw_value in env_cfg.items():
            text = str(raw_value or "").strip()
            env_name = ""
            match = MCP_ENV_VAR_PATTERN.fullmatch(text)
            if match:
                env_name = match.group(1).strip()
                value = os.getenv(env_name, "")
            else:
                env_name = str(config_key)
                value = text
            result.append(
                {
                    "config_key": str(config_key),
                    "env_name": env_name,
                    "template": text,
                    "value": value,
                }
            )
        return result

    def _build_mcp_metadata(self, mcp_servers: Dict[str, Any]) -> Dict[str, Any]:
        """
        构建 MCP 展示元数据。

        Args:
            mcp_servers (Dict[str, Any]): 规范化后的 mcp_servers。

        Returns:
            Dict[str, Any]: metadata 字典。
        """
        runtime_tools = self._runtime_mcp_tool_map()
        metadata: Dict[str, Any] = {}
        for server_name, server_cfg in mcp_servers.items():
            cfg = server_cfg if isinstance(server_cfg, dict) else {}
            config_tools = self._normalize_tool_list(cfg.get("tools", []))
            tools = runtime_tools.get(server_name) or config_tools
            metadata[server_name] = {
                "description": str(cfg.get("description", "")),
                "tools": tools,
                "required_keys": self._parse_mcp_required_keys(cfg.get("env", {})),
            }
        return metadata

    def get(self) -> Dict[str, Any]:
        """
        获取 MCP 配置与展示元数据。

        Args:
            None

        Returns:
            Dict[str, Any]: `mcp_servers` 与 `metadata`。
        """
        mcp_data = self.runtime.load_mcp_file()
        mcp_servers = self._normalize_mcp_servers(mcp_data.get("mcp_servers", {}))
        return {
            "mcp_servers": mcp_servers,
            "metadata": self._build_mcp_metadata(mcp_servers),
        }

    async def update(self, request: UpdateMcpSettingsRequest) -> Dict[str, Any]:
        """
        更新 MCP 配置并刷新运行时。

        Args:
            request (UpdateMcpSettingsRequest): MCP 更新请求。

        Returns:
            Dict[str, Any]: 更新结果。
        """
        # 读取旧配置并只替换 mcp_servers。
        current = self.runtime.load_mcp_file()
        next_servers = self._normalize_mcp_servers(request.mcp_servers or {})
        current["mcp_servers"] = next_servers
        self.runtime.save_mcp_file(current)
        await self.runtime.reload_agent_with_mcp()
        return {"success": True, "message": "MCP settings updated successfully"}

    def _extract_env_names_from_cfg(self, env_cfg: Dict[str, Any]) -> List[str]:
        """
        从 MCP 的 `env` 配置中提取环境变量名。

        支持三种写法：
        1. `{"KEY": "${ENV_NAME}"}`
        2. `{"KEY": "ENV_NAME"}`
        3. `{"ENV_NAME": "literal-value"}`
        """
        names: set[str] = set()
        if not isinstance(env_cfg, dict):
            return []

        for key, value in env_cfg.items():
            key_name = str(key or "").strip()
            text = str(value or "").strip()
            env_name = ""

            match = MCP_ENV_VAR_PATTERN.fullmatch(text)
            if match:
                env_name = match.group(1).strip()
            elif looks_like_env_key_name(text):
                env_name = text
            elif looks_like_env_key_name(key_name):
                env_name = key_name

            if env_name:
                names.add(env_name)

        return sorted(names)

    async def update_server_env(self, server_name: str, request: UpdateMcpServerEnvRequest) -> Dict[str, Any]:
        """
        更新单个 MCP Server 的环境变量，并立即重载 MCP。
        """
        name = str(server_name or "").strip()
        if not name:
            raise ValueError("server_name 不能为空")

        current_data = self.runtime.load_mcp_file()
        current_servers = self._normalize_mcp_servers(current_data.get("mcp_servers", {}))
        if name not in current_servers:
            raise ValueError(f"MCP Server '{name}' 不存在")

        allowed_env_names = set(self._extract_env_names_from_cfg(current_servers[name].get("env", {})))
        incoming = request.values or {}
        env_updates: Dict[str, str] = {}

        for raw_key, raw_value in incoming.items():
            env_name = str(raw_key or "").strip()
            if not env_name:
                continue
            if allowed_env_names and env_name not in allowed_env_names:
                continue
            env_updates[env_name] = str(raw_value or "").strip()

        if not env_updates:
            raise ValueError("没有可更新的 Key")

        self.runtime.apply_env_updates(env_updates)
        await self.runtime.reload_agent_with_mcp()
        return UpdateMcpServerEnvResponse(
            success=True,
            message="MCP Key 更新成功",
            server_name=name,
            updated_env_keys=sorted(env_updates.keys()),
            mcp_servers=current_servers,
            metadata=self._build_mcp_metadata(current_servers),
        ).model_dump()

    async def delete_server(self, server_name: str) -> Dict[str, Any]:
        """
        删除单个 MCP Server，并清理其独占的 `.env` 键。
        """
        name = str(server_name or "").strip()
        if not name:
            raise ValueError("server_name 不能为空")

        current_data = self.runtime.load_mcp_file()
        current_servers = self._normalize_mcp_servers(current_data.get("mcp_servers", {}))
        if name not in current_servers:
            raise ValueError(f"MCP Server '{name}' 不存在")

        target_cfg = current_servers.get(name) or {}
        target_env_names = set(self._extract_env_names_from_cfg(target_cfg.get("env", {})))

        current_servers.pop(name, None)
        current_data["mcp_servers"] = current_servers
        self.runtime.save_mcp_file(current_data)

        remaining_env_names: set[str] = set()
        for cfg in current_servers.values():
            remaining_env_names.update(self._extract_env_names_from_cfg(cfg.get("env", {})))

        cleanup_keys = sorted(target_env_names - remaining_env_names)
        removed_env_keys = self.runtime.remove_env_keys(cleanup_keys)

        await self.runtime.reload_agent_with_mcp()
        return DeleteMcpServerResponse(
            success=True,
            message="MCP 服务删除成功",
            deleted_server=name,
            removed_env_keys=removed_env_keys,
            mcp_servers=current_servers,
            metadata=self._build_mcp_metadata(current_servers),
        ).model_dump()

    def _load_paste_json(self, raw_text: str) -> Dict[str, Any]:
        """
        解析前端粘贴的 JSON 文本。
        """
        text = str(raw_text or "").strip()
        if not text:
            raise ValueError("粘贴内容不能为空")
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ValueError(f"JSON 解析失败: {exc}") from exc
        if not isinstance(payload, dict):
            raise ValueError("粘贴内容必须是 JSON 对象")
        return payload

    def _extract_servers_from_payload(self, payload: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
        """
        从粘贴 JSON 中提取 MCP Server 映射。
        """
        for key in MCP_PASTE_KEY_CANDIDATES:
            candidate = payload.get(key)
            if isinstance(candidate, dict):
                return {str(k): v for k, v in candidate.items() if isinstance(v, dict)}

        if all(isinstance(v, dict) for v in payload.values()):
            extracted: Dict[str, Dict[str, Any]] = {}
            for name, cfg in payload.items():
                hint = set(cfg.keys())
                if hint & MCP_SERVER_HINT_KEYS:
                    extracted[str(name)] = cfg
            if extracted:
                return extracted
        return {}

    def _normalize_env_for_import(
        self, env_cfg: Dict[str, Any], existing_env: Dict[str, str]
    ) -> tuple[Dict[str, str], Dict[str, str]]:
        """
        规范化导入的 env 配置，输出：
        - mcp.json 存储形态：`{"KEY": "ENV_NAME"}`
        - `.env` 待更新项：`{"ENV_NAME": "value"}`
        """
        normalized_env: Dict[str, str] = {}
        env_updates: Dict[str, str] = {}
        if not isinstance(env_cfg, dict):
            return normalized_env, env_updates

        for raw_key, raw_value in env_cfg.items():
            config_key = str(raw_key or "").strip()
            if not config_key:
                continue

            value_text = str(raw_value or "").strip()
            env_name = config_key if looks_like_env_key_name(config_key) else config_key.upper()
            normalized_env[config_key] = env_name

            match = MCP_ENV_VAR_PATTERN.fullmatch(value_text)
            if match:
                env_name = match.group(1).strip() or env_name
                normalized_env[config_key] = env_name
                if env_name not in existing_env:
                    env_updates.setdefault(env_name, "")
                continue

            if looks_like_env_key_name(value_text):
                env_name = value_text
                normalized_env[config_key] = env_name
                if env_name not in existing_env:
                    env_updates.setdefault(env_name, "")
                continue

            if not value_text or MCP_PLACEHOLDER_PATTERN.fullmatch(value_text):
                env_updates.setdefault(env_name, "")
                continue

            if env_name not in existing_env:
                env_updates[env_name] = value_text

        return normalized_env, env_updates

    async def import_from_paste(self, request: ImportMcpPasteRequest) -> Dict[str, Any]:
        """
        从粘贴文本导入 MCP 配置，并写入 `mcp.json` 与 `.env`。
        """
        payload = self._load_paste_json(request.raw_text)
        incoming_servers = self._extract_servers_from_payload(payload)
        if not incoming_servers:
            raise ValueError("未解析到可导入的 MCP Server")

        current_data = self.runtime.load_mcp_file()
        current_servers = self._normalize_mcp_servers(current_data.get("mcp_servers", {}))
        existing_env = self.runtime._read_env_file()

        imported_servers: List[str] = []
        skipped_servers: List[str] = []
        merged_env_updates: Dict[str, str] = {}

        for server_name, raw_cfg in incoming_servers.items():
            name = str(server_name or "").strip()
            if not name:
                continue

            if not request.overwrite_existing and name in current_servers:
                skipped_servers.append(name)
                continue

            cfg = copy.deepcopy(raw_cfg) if isinstance(raw_cfg, dict) else {}
            cfg["enabled"] = bool(cfg.get("enabled", True))
            cfg["command"] = str(cfg.get("command", "")).strip()
            cfg["url"] = str(cfg.get("url", "")).strip()
            cfg["transport"] = str(cfg.get("transport", "stdio")).strip() or "stdio"

            raw_args = cfg.get("args", [])
            cfg["args"] = [str(arg).strip() for arg in raw_args] if isinstance(raw_args, list) else []
            cfg["args"] = [arg for arg in cfg["args"] if arg]

            if not cfg["command"] and not cfg["url"]:
                skipped_servers.append(name)
                continue

            normalized_env, env_updates = self._normalize_env_for_import(cfg.get("env", {}), existing_env)
            cfg["env"] = normalized_env
            merged_env_updates.update(env_updates)
            current_servers[name] = cfg
            imported_servers.append(name)

        if not imported_servers:
            raise ValueError("没有可导入的 MCP Server（可能都被跳过）")

        current_data["mcp_servers"] = current_servers
        self.runtime.save_mcp_file(current_data)
        if merged_env_updates:
            self.runtime.apply_env_updates(merged_env_updates)

        await self.runtime.reload_agent_with_mcp()
        return {
            "success": True,
            "message": "MCP 配置导入成功",
            "imported_servers": imported_servers,
            "skipped_servers": skipped_servers,
            "updated_env_keys": sorted(merged_env_updates.keys()),
            "mcp_servers": current_servers,
            "metadata": self._build_mcp_metadata(current_servers),
        }


class SettingsService:
    """
    设置服务调度层。

    仅负责路由层调用协调，不承载字段细节实现。
    """

    def __init__(self) -> None:
        """
        初始化设置服务并装配各业务模块。

        Args:
            None

        Returns:
            None
        """
        self.runtime = SettingsRuntime()
        self.ui_support = UiSettingsSupport(self.runtime)
        # 五个模块分别承载各自逻辑。
        self.api_module = ApiSettingsModule(self.runtime)
        self.path_module = PathSettingsModule(self.runtime)
        self.theme_module = ThemeSettingsModule(self.ui_support)
        self.font_module = FontSettingsModule(self.ui_support)
        self.mcp_module = McpSettingsModule(self.runtime)

    @property
    def paths(self):
        """
        获取路径配置管理器。

        Args:
            None

        Returns:
            Any: 路径配置管理器对象。
        """
        return self.runtime.paths

    async def get_settings(self) -> Dict[str, Any]:
        """
        获取设置页完整数据。

        Args:
            None

        Returns:
            Dict[str, Any]: `config`、`api`、`paths`、`ui` 聚合结果。
        """
        try:
            # 聚合读取 config + settings + 模块计算结果。
            config = self.paths.load_config()
            settings = self.runtime.load_settings()
            api = self.api_module.get(settings=settings, config=config)
            path_model = self.path_module.get(settings=settings)
            tts_cfg = api.tts if isinstance(api.tts, dict) else {}
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
                        "provider": tts_cfg.get("provider"),
                        "providers": tts_cfg.get("providers", {}),
                    },
                },
                "api": api.model_dump(),
                "paths": path_model.model_dump(),
                "ui": self.ui_support.load_ui_settings(settings),
            }
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to load settings: {exc}")

    async def update_settings(self, request: UpdateSettingsRequest) -> Dict[str, Any]:
        """
        通用设置更新入口（按分区转发）。

        Args:
            request (UpdateSettingsRequest): 设置更新请求。

        Returns:
            Dict[str, Any]: 更新结果。
        """
        try:
            # 仅做调度，不实现字段逻辑。
            if request.api is not None:
                self.api_module.update(request.api)
            if request.paths is not None:
                self.path_module.update(request.paths)
            if request.ui is not None:
                self.theme_module.update(request.ui.theme)
                self.font_module.update(request.ui.font)
            return {"success": True, "message": "Settings updated successfully"}
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to update settings: {exc}")

    async def update_api_settings(self, api: ApiConfigModel) -> Dict[str, Any]:
        """
        更新 API 分区。

        Args:
            api (ApiConfigModel): API 配置模型。

        Returns:
            Dict[str, Any]: 更新结果。
        """
        try:
            return self.api_module.update(api)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to update api settings: {exc}")

    async def update_paths_settings(self, paths: PathConfigModel) -> Dict[str, Any]:
        """
        更新路径分区。

        Args:
            paths (PathConfigModel): 路径配置模型。

        Returns:
            Dict[str, Any]: 更新结果。
        """
        try:
            return self.path_module.update(paths)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to update path settings: {exc}")

    async def list_models(self) -> Dict[str, Any]:
        """
        获取模型列表。

        Args:
            None

        Returns:
            Dict[str, Any]: 模型清单与选中模型。
        """
        try:
            return self.api_module.list_models()
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to list models: {exc}")

    async def switch_model(self, request: SwitchModelRequest) -> Dict[str, Any]:
        """
        切换模型。

        Args:
            request (SwitchModelRequest): 模型切换请求。

        Returns:
            Dict[str, Any]: 切换结果。
        """
        try:
            return self.api_module.switch_model(request)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to switch model: {exc}")

    async def get_paths_info(self) -> Dict[str, str]:
        """
        获取路径信息。

        Args:
            None

        Returns:
            Dict[str, str]: 关键目录路径信息。
        """
        return self.path_module.get_paths_info()

    async def pick_directory(self, request: DirectoryPickerRequest) -> Dict[str, str]:
        """
        打开目录选择器。

        Args:
            request (DirectoryPickerRequest): 目录选择请求。

        Returns:
            Dict[str, str]: 目录选择结果。
        """
        return self.path_module.pick_directory(request)

    async def get_system_status(self) -> SystemStatusResponse:
        """
        获取系统状态。

        Args:
            None

        Returns:
            SystemStatusResponse: 系统状态对象。
        """
        return self.api_module.get_system_status()

    async def get_theme_settings(self) -> Dict[str, Any]:
        """
        获取主题配置。

        Args:
            None

        Returns:
            Dict[str, Any]: 主题配置。
        """
        return self.theme_module.get()

    async def update_theme_settings(self, theme: UiThemeModel) -> Dict[str, Any]:
        """
        更新主题配置。

        Args:
            theme (UiThemeModel): 主题配置模型。

        Returns:
            Dict[str, Any]: 更新结果。
        """
        return self.theme_module.update(theme)

    async def get_font_settings(self) -> Dict[str, Any]:
        """
        获取字体配置。

        Args:
            None

        Returns:
            Dict[str, Any]: 字体配置。
        """
        return self.font_module.get()

    async def update_font_settings(self, font: UiFontModel) -> Dict[str, Any]:
        """
        更新字体配置。

        Args:
            font (UiFontModel): 字体配置模型。

        Returns:
            Dict[str, Any]: 更新结果。
        """
        return self.font_module.update(font)

    async def get_tts_settings(self) -> Dict[str, Any]:
        """
        获取 TTS 配置。

        Args:
            None

        Returns:
            Dict[str, Any]: TTS 配置字典。
        """
        return self.api_module.get_tts_settings()

    async def get_mcp_settings(self) -> Dict[str, Any]:
        """
        获取 MCP 配置。

        Args:
            None

        Returns:
            Dict[str, Any]: MCP 配置与展示元数据。
        """
        try:
            return self.mcp_module.get()
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to load mcp settings: {exc}")

    async def update_mcp_settings(self, request: UpdateMcpSettingsRequest) -> Dict[str, Any]:
        """
        更新 MCP 配置。

        Args:
            request (UpdateMcpSettingsRequest): MCP 更新请求模型。

        Returns:
            Dict[str, Any]: 更新结果。
        """
        try:
            return await self.mcp_module.update(request)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to update mcp settings: {exc}")

    async def import_mcp_from_paste(self, request: ImportMcpPasteRequest) -> Dict[str, Any]:
        """
        粘贴导入 MCP 配置。
        """
        try:
            return await self.mcp_module.import_from_paste(request)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to import mcp settings: {exc}")

    async def update_mcp_server_env(self, server_name: str, request: UpdateMcpServerEnvRequest) -> Dict[str, Any]:
        """
        更新单个 MCP Server 的 Key（`.env` 值）。
        """
        try:
            return await self.mcp_module.update_server_env(server_name, request)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to update mcp server key: {exc}")

    async def delete_mcp_server(self, server_name: str) -> Dict[str, Any]:
        """
        删除单个 MCP Server，并清理对应 `.env` 键。
        """
        try:
            return await self.mcp_module.delete_server(server_name)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to delete mcp server: {exc}")

    async def switch_tts_provider(self, body: SwitchTtsProviderRequest) -> Dict[str, Any]:
        """
        切换 TTS Provider。

        Args:
            body (SwitchTtsProviderRequest): TTS Provider 切换请求。

        Returns:
            Dict[str, Any]: 切换结果。
        """
        return self.api_module.switch_tts_provider(body)


_settings_service: Optional[SettingsService] = None


def get_settings_service() -> SettingsService:
    """
    获取 SettingsService 单例。

    Args:
        None

    Returns:
        SettingsService: 服务单例对象。

    Example:
    ```
        service = get_settings_service()
        => <SettingsService ...>
    ```
    """
    global _settings_service
    if _settings_service is None:
        _settings_service = SettingsService()
    return _settings_service
