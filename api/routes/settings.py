"""
设置路由模块

该模块提供模型配置 路径配置 UI 主题字体配置 与系统状态查询接口
"""

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Body
from pydantic import BaseModel, Field

from config.paths import get_paths
from utils.logger import logger

router = APIRouter()

# 预定义 provider 到环境变量映射 用于自动解析与更新 API Key
PROVIDER_ENV_MAP = {
    "deepseek": "DEEPSEEK_API_KEY",
    "openai": "OPENAI_API_KEY",
    "qwen": "QWEN_API_KEY",
}


class TtsProviderConfig(BaseModel):
    """
    单个 TTS 提供商的配置。
    允许任意额外字段，以应对不同 provider 的多样化参数。
    主要处理 `api_key` 的脱敏和环境变量写入。
    
    - api_key (Optional[str]): 明文 API Key（前端传递时可能是明文或脱敏值）
    - api_key_env (Optional[str]): 存储时使用的环境变量名
    """
    api_key: Optional[str] = None # 前端传递时可能是明文或脱敏值
    api_key_env: Optional[str] = None # 存储时使用的环境变量名
    # 允许任意其他字段
    class Config:
        extra = "allow"

class TtsConfigModel(BaseModel):
    """
    完整的 TTS 配置
    
    - provider (str): 当前选中的 provider 名称
    - providers (Dict[str, TtsProviderConfig]): 各 provider 配置字典
    """
    provider: str = "siliconflow" # 当前选中的 provider 名称
    providers: Dict[str, TtsProviderConfig] = Field(default_factory=dict)
    # 允许任意其他字段
    class Config:
        extra = "allow"


class ApiConfigModel(BaseModel):
    """
    API 配置响应模型

    - selected_model (str): 当前选中模型
    - openai_api_key (str): 选中模型密钥脱敏值
    - openai_base_url (str): 选中模型基地址
    - openai_model (str): 选中模型名称
    - provider_keys (Dict[str str]): 各 provider 密钥脱敏值
    - silicon_api_key (str): silicon 密钥脱敏值
    - embeddings_api_key (str): 向量密钥脱敏值
    - tts_api_key (str): 语音密钥脱敏值
    - embeddings_model (str): 向量模型名
    - embeddings_base_url (str): 向量基地址
    - tts_model (str): 语音模型名
    - tts_voice (str): 语音音色名
    - temperature (float): 采样温度
    - max_tokens (int): 最大输出 token
    - top_p (float): nucleus 参数
    - timeout (int): 超时秒数
    """
    selected_model: str = "deepseek-chat"
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    openai_model: str = "gpt-4o"
    provider_keys: Dict[str, str] = Field(default_factory=dict)

    # 保留siliconflow相关字段 用于 embedding 等
    silicon_api_key: str = ""
    embeddings_api_key: str = ""
    embeddings_model: str = "Pro/BAAI/bge-m3"
    embeddings_base_url: str = "https://api.siliconflow.cn/v1"
    # 现在由统一的 tts 对象管理
    tts_api_key: str = Field(default="", deprecated=True)
    tts_model: str = Field(default="FunAudioLLM/CosyVoice2-0.5B", deprecated=True)
    tts_voice: str = Field(default="Alex_zh", deprecated=True)
    # 新的 tts 对象
    tts: Optional[TtsConfigModel] = None

    temperature: float = 0.7
    max_tokens: int = 4096
    top_p: float = 1.0
    timeout: int = 60


class PathConfigModel(BaseModel):
    """
    路径配置模型

    - data_dir (str): 数据目录
    - audio_dir (str): 音频目录
    - log_dir (str): 日志目录
    - music_dir (str): 音乐目录
    """
    data_dir: str = "./data"
    audio_dir: str = "./data/audio/output"
    log_dir: str = "./logs"
    music_dir: str = "./data/music"


class UiThemeModel(BaseModel):
    """
    主题配置模型

    - mode (str): 主题模式 light dark auto
    - ema_rgb (List[int]): 主色 rgb
    - accent_rgb (List[int]): 强调色 rgb
    - panel_rgb (List[int]): 面板色 rgb
    - panel_alpha (float): 面板透明度
    """
    mode: str = "light"
    ema_rgb: List[int] = Field(default_factory=lambda: [139, 92, 246])
    accent_rgb: List[int] = Field(default_factory=lambda: [59, 130, 246])
    panel_rgb: List[int] = Field(default_factory=lambda: [255, 255, 255])
    panel_alpha: float = 0.6


class UiFontModel(BaseModel):
    """
    字体配置模型

    - family (str): 字体族
    - size_scale (float): 字号缩放
    - weight (int): 字重
    """
    family: str = "'Microsoft YaHei', 'PingFang SC', sans-serif"
    size_scale: float = 1.0
    weight: int = 400


class UiConfigModel(BaseModel):
    """
    UI 配置模型

    - theme (UiThemeModel): 主题配置
    - font (UiFontModel): 字体配置
    """
    theme: UiThemeModel = Field(default_factory=UiThemeModel)
    font: UiFontModel = Field(default_factory=UiFontModel)


class UpdateSettingsRequest(BaseModel):
    """
    更新设置请求模型

    - api (Optional[ApiConfigModel]): API 配置
    - paths (Optional[PathConfigModel]): 路径配置
    - ui (Optional[UiConfigModel]): UI 配置
    - tts (Optional[TtsConfigModel]): TTS 配置
    """
    api: Optional[ApiConfigModel] = None
    paths: Optional[PathConfigModel] = None
    ui: Optional[UiConfigModel] = None
    tts: Optional[TtsConfigModel] = None


class SwitchModelRequest(BaseModel):
    """
    切换模型请求模型

    - model (str): 目标模型 id
    """
    model: str


class DirectoryPickerRequest(BaseModel):
    """
    目录选择请求模型

    - initial_dir (str): 初始目录
    - title (str): 窗口标题
    """
    initial_dir: str = ""
    title: str = "Select Directory"


class SystemStatusResponse(BaseModel):
    """
    系统状态响应模型

    - backend (bool): 后端状态
    - websocket (bool): websocket 状态
    - tts (bool): tts 可用状态
    - embeddings (bool): 向量可用状态
    - llm (bool): llm 可用状态
    """
    backend: bool = True
    websocket: bool = True
    tts: bool = False
    embeddings: bool = False
    llm: bool = False


def _mask_key(key: str) -> str:
    """
    脱敏显示 API Key

    Args:
        key (str): 原始密钥

    Returns:
        str: 脱敏后密钥
    """
    if not key:
        return ""
    if len(key) < 12:
        return key
    return key[:8] + "•" * (len(key) - 12) + key[-4:]


def _mask_tts_config(tts_cfg: dict) -> dict:
    """
    对 TTS 配置中的 api_key 进行脱敏
    
    Args:
        tts_cfg (dict): 原始 TTS 配置字典
    
    Returns:
        dict: 脱敏后的 TTS 配置字典
    """
    if not tts_cfg:
        return tts_cfg
    providers = tts_cfg.get("providers", {})
    for provider in providers.values():
        if isinstance(provider, dict) and "api_key" in provider:
            provider["api_key"] = _mask_key(provider["api_key"])
    return tts_cfg


def deep_merge(base: Dict, update: Dict) -> Dict:
    """递归合并两个字典, update 中的值会覆盖 base 中的值"""
    for key, value in update.items():
        if isinstance(value, dict) and key in base and isinstance(base[key], dict):
            deep_merge(base[key], value)
        else:
            base[key] = value
    return base


def _get_config_file() -> Path:
    """
    获取 settings 文件路径

    Args:
        None

    Returns:
        Path: settings 文件路径
    """
    return get_paths().settings_json


def _load_settings() -> Dict[str, Any]:
    """
    读取 settings 文件

    Args:
        None

    Returns:
        Dict[str Any]: 设置字典
    """
    p = _get_config_file()
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return {}


def _save_settings(settings: Dict[str, Any]):
    """
    保存 settings 文件

    Args:
        settings (Dict[str Any]): 待保存设置字典

    Returns:
        None
    """
    p = _get_config_file()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")


def _read_env_file() -> Dict[str, str]:
    """
    读取 .env 为键值映射

    Args:
        None

    Returns:
        Dict[str str]: 环境变量键值映射
    """
    paths = get_paths()
    result: Dict[str, str] = {}
    if not paths.env_file.exists():
        return result

    # 按行解析 key=value
    for raw_line in paths.env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        result[k.strip()] = v.strip().strip('"').strip("'")
    return result


def _write_env_file(env_values: Dict[str, str]):
    """
    写回 .env 键值

    Args:
        env_values (Dict[str str]): 待写入键值映射

    Returns:
        None
    """
    paths = get_paths()
    old_lines = []
    if paths.env_file.exists():
        old_lines = paths.env_file.read_text(encoding="utf-8").splitlines()

    consumed = set()
    new_lines: List[str] = []

    # 优先覆盖旧键并保留原有注释与无关配置
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

    # 追加新键
    for key, value in env_values.items():
        if key not in consumed:
            new_lines.append(f"{key}={value}")

    paths.env_file.write_text("\n".join(new_lines).strip() + "\n", encoding="utf-8")


def _resolve_models(config: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """
    解析模型目录字典

    Args:
        config (Dict[str Any]): 主配置字典

    Returns:
        Dict[str Dict[str Any]]: 模型目录映射
    """
    models = config.get("llm_models", {})
    if isinstance(models, dict):
        return models
    return {}


def _resolve_selected_model(settings: Dict[str, Any], config: Dict[str, Any]) -> str:
    """
    解析当前选中模型

    Args:
        settings (Dict[str Any]): 设置字典
        config (Dict[str Any]): 主配置字典

    Returns:
        str: 选中模型 id
    """
    api_settings = settings.get("api", {})
    llm_defaults = config.get("llm", {})

    return (
        api_settings.get("selected_model")
        or api_settings.get("openai_model")
        or llm_defaults.get("model")
        or "deepseek-chat"
    )


def _build_model_item(model_id: str, info: Dict[str, Any]) -> Dict[str, Any]:
    """
    构建模型列表项

    Args:
        model_id (str): 模型 id
        info (Dict[str Any]): 模型配置字典

    Returns:
        Dict[str Any]: 模型列表项字典
    """
    provider = info.get("provider", "")
    env_name = info.get("api_key_env") or PROVIDER_ENV_MAP.get(provider, "")
    key = os.getenv(env_name, "") if env_name else ""
    enabled = bool(key and not key.lower().startswith("your_"))

    return {
        "id": model_id,
        "label": info.get("label", model_id),
        "provider": provider,
        "base_url": info.get("base_url", ""),
        "api_key_env": env_name,
        "enabled": enabled,
    }


def _get_selected_model_meta(config: Dict[str, Any], selected_model: str) -> Dict[str, Any]:
    """
    获取选中模型元数据

    Args:
        config (Dict[str Any]): 主配置字典
        selected_model (str): 选中模型 id

    Returns:
        Dict[str Any]: 模型元数据字典
    """
    models = _resolve_models(config)
    return models.get(selected_model, {})


def _resolve_provider_keys(config: Dict[str, Any]) -> Dict[str, str]:
    """
    解析所有 provider 当前密钥

    Args:
        config (Dict[str Any]): 主配置字典

    Returns:
        Dict[str str]: provider 到密钥映射
    """
    providers = set(PROVIDER_ENV_MAP.keys())

    for item in _resolve_models(config).values():
        if isinstance(item, dict) and item.get("provider"):
            providers.add(item["provider"])

    result = {}
    for provider in providers:
        env_name = PROVIDER_ENV_MAP.get(provider)
        if env_name:
            result[provider] = os.getenv(env_name, "")
    return result


def _allowed_providers(config: Dict[str, Any]) -> set[str]:
    """
    获取允许写入的 provider 集合

    Args:
        config (Dict[str Any]): 主配置字典

    Returns:
        set[str]: provider 集合
    """
    providers = set(PROVIDER_ENV_MAP.keys())
    for item in _resolve_models(config).values():
        if isinstance(item, dict) and item.get("provider"):
            providers.add(str(item["provider"]))
    return providers


def _resolve_selected_model_key(selected_model_meta: Dict[str, Any]) -> str:
    """
    获取选中模型密钥

    Args:
        selected_model_meta (Dict[str Any]): 选中模型元数据

    Returns:
        str: 模型密钥
    """
    env_name = selected_model_meta.get("api_key_env")
    if env_name:
        return os.getenv(env_name, "")
    return ""


def _get_theme_file() -> Path:
    """
    获取主题文件路径

    Args:
        None

    Returns:
        Path: 主题文件路径
    """
    return get_paths().data_dir / "theme" / "theme.json"


def _get_font_file() -> Path:
    """
    获取字体文件路径

    Args:
        None

    Returns:
        Path: 字体文件路径
    """
    return get_paths().data_dir / "font" / "font.json"


def _safe_rgb(rgb: Any, fallback: List[int]) -> List[int]:
    """
    安全规范化 RGB 数组

    Args:
        rgb (Any): 输入 rgb
        fallback (List[int]): 回退 rgb

    Returns:
        List[int]: 规范化 rgb
    """
    if not isinstance(rgb, list) or len(rgb) != 3:
        return fallback
    result: List[int] = []
    for i, item in enumerate(rgb):
        try:
            v = int(item)
        except Exception:
            v = fallback[i]
        result.append(max(0, min(255, v)))
    return result


def _load_ui_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    """
    加载并合并 UI 设置

    合并顺序为默认值 文件值 settings 值

    Args:
        settings (Dict[str Any]): 设置字典

    Returns:
        Dict[str Any]: 规范化 UI 设置
    """
    default_ui = UiConfigModel().model_dump()
    ui = settings.get("ui", {}) if isinstance(settings.get("ui"), dict) else {}

    theme_file = _get_theme_file()
    font_file = _get_font_file()

    file_theme: Dict[str, Any] = {}
    file_font: Dict[str, Any] = {}

    # 读取主题文件
    if theme_file.exists():
        try:
            file_theme = json.loads(theme_file.read_text(encoding="utf-8"))
        except Exception:
            file_theme = {}
    # 读取字体文件
    if font_file.exists():
        try:
            file_font = json.loads(font_file.read_text(encoding="utf-8"))
        except Exception:
            file_font = {}

    merged_theme = {
        **default_ui["theme"],
        **file_theme,
        **(ui.get("theme", {}) if isinstance(ui.get("theme"), dict) else {}),
    }
    merged_font = {
        **default_ui["font"],
        **file_font,
        **(ui.get("font", {}) if isinstance(ui.get("font"), dict) else {}),
    }

    # 规范化主题 rgb 与透明度
    merged_theme["ema_rgb"] = _safe_rgb(merged_theme.get("ema_rgb"), default_ui["theme"]["ema_rgb"])
    merged_theme["accent_rgb"] = _safe_rgb(merged_theme.get("accent_rgb"), default_ui["theme"]["accent_rgb"])
    merged_theme["panel_rgb"] = _safe_rgb(merged_theme.get("panel_rgb"), default_ui["theme"]["panel_rgb"])
    try:
        merged_theme["panel_alpha"] = max(0.0, min(1.0, float(merged_theme.get("panel_alpha", 0.6))))
    except Exception:
        merged_theme["panel_alpha"] = 0.6

    # 规范化字体缩放与字重
    try:
        merged_font["size_scale"] = max(0.7, min(1.6, float(merged_font.get("size_scale", 1.0))))
    except Exception:
        merged_font["size_scale"] = 1.0
    try:
        merged_font["weight"] = max(300, min(800, int(merged_font.get("weight", 400))))
    except Exception:
        merged_font["weight"] = 400
    merged_font["family"] = str(merged_font.get("family") or default_ui["font"]["family"])

    return UiConfigModel(
        theme=UiThemeModel(**merged_theme),
        font=UiFontModel(**merged_font),
    ).model_dump()


def _save_ui_files(ui: Dict[str, Any]):
    """
    保存主题与字体文件

    Args:
        ui (Dict[str Any]): UI 设置字典

    Returns:
        None
    """
    theme_file = _get_theme_file()
    font_file = _get_font_file()
    theme_file.parent.mkdir(parents=True, exist_ok=True)
    font_file.parent.mkdir(parents=True, exist_ok=True)
    theme_file.write_text(json.dumps(ui.get("theme", {}), ensure_ascii=False, indent=2), encoding="utf-8")
    font_file.write_text(json.dumps(ui.get("font", {}), ensure_ascii=False, indent=2), encoding="utf-8")


def _default_paths_dict() -> Dict[str, str]:
    """
    返回默认路径配置字典
    """
    return PathConfigModel().model_dump()


def _ensure_paths_settings(settings: Dict[str, Any]) -> bool:
    """
    确保 settings 中存在完整 paths 配置

    Returns:
        bool: 是否发生变更
    """
    changed = False
    defaults = _default_paths_dict()
    paths_cfg = settings.get("paths")
    if not isinstance(paths_cfg, dict):
        settings["paths"] = defaults.copy()
        return True

    for key, default_val in defaults.items():
        if not isinstance(paths_cfg.get(key), str) or not str(paths_cfg.get(key)).strip():
            paths_cfg[key] = default_val
            changed = True

    settings["paths"] = paths_cfg
    return changed


@router.get("/settings")
async def get_settings():
    """
    获取完整设置

    Args:
        None

    Returns:
        Dict[str Any]: 设置响应字典

    Raises:
        HTTPException: 读取失败时抛出 500
    """
    try:
        paths = get_paths()
        # 读取主配置与 settings
        config = paths.load_config()
        settings = _load_settings()
        if _ensure_paths_settings(settings):
            _save_settings(settings)

        # 获取原始 api 字典并创建副本以避免修改原数据
        raw_api = settings.get("api", {}).copy()

        # 对 TTS 配置进行脱敏处理
        raw_api["tts"] = _mask_tts_config(raw_api.get("tts", {}).copy())
        
        # 解析当前模型与密钥信息
        selected_model = _resolve_selected_model(settings, config)
        selected_meta = _get_selected_model_meta(config, selected_model)
        provider_keys = _resolve_provider_keys(config)
        api_settings = raw_api  # 使用脱敏后的 raw_api
        ui_settings = _load_ui_settings(settings)

        # embeddings 与 tts 支持独立 key 与 silicon 回退
        embeddings_key = os.getenv("EMBEDDINGS_API_KEY", "") or os.getenv("SILICONFLOW_API_KEY", "")

        # 组装 API 响应模型
        api_config = ApiConfigModel(
            selected_model=selected_model,
            openai_api_key=_mask_key(_resolve_selected_model_key(selected_meta)),
            openai_base_url=selected_meta.get("base_url", config.get("llm", {}).get("base_url", "https://api.openai.com/v1")),
            openai_model=selected_model,
            provider_keys={k: _mask_key(v) for k, v in provider_keys.items()},
            silicon_api_key=_mask_key(os.getenv("SILICONFLOW_API_KEY", "")),
            embeddings_api_key=_mask_key(embeddings_key),
            embeddings_model=api_settings.get("embeddings_model", config.get("embeddings", {}).get("model", "Pro/BAAI/bge-m3")),
            embeddings_base_url=api_settings.get("embeddings_base_url", config.get("embeddings", {}).get("base_url", "https://api.siliconflow.cn/v1")),
            temperature=float(api_settings.get("temperature", config.get("llm", {}).get("temperature", 0.7))),
            max_tokens=int(api_settings.get("max_tokens", config.get("llm", {}).get("max_tokens", 4096))),
            top_p=float(api_settings.get("top_p", config.get("llm", {}).get("top_p", 1.0))),
            timeout=int(api_settings.get("timeout", config.get("llm", {}).get("timeout", 60))),
            # tts_api_key=_mask_key(tts_key),
            # tts_model=api_settings.get("tts_model", config.get("tts", {}).get("model", "FunAudioLLM/CosyVoice2-0.5B")),
            # tts_voice=api_settings.get("tts_voice", "Alex_zh"),
            tts=raw_api.get("tts") # 使用脱敏后的 TTS 配置
        )

        # 组装路径响应模型
        path_settings = settings.get("paths", {})
        path_config = PathConfigModel(
            data_dir=path_settings.get("data_dir", str(paths.data_dir)),
            audio_dir=path_settings.get("audio_dir", str(paths.audio_output_dir)),
            log_dir=path_settings.get("log_dir", str(paths.logs_dir)),
            music_dir=path_settings.get("music_dir", str(paths.music_dir)),
        )

        # 组装公开配置 不返回原始密钥
        public_config = {
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
            "tts": { # XXX 这一部分不清楚前端是怎么运作的 暂时保留了老字段 需要修改前端以适配新的 TTS 配置结构
                "provider": config.get("tts", {}).get("provider"),
                "providers": raw_api.get("tts", {}).get("providers", {}),
                "model": config.get("tts", {}).get("model", ""), # deprecated
                "base_url": config.get("tts", {}).get("base_url", "https://api.siliconflow.cn/v1"), # deprecated
            },
        }

        return {
            "config": public_config,
            "api": api_config,
            "paths": path_config,
            "ui": ui_settings,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load settings: {e}")


@router.put("/settings")
async def update_settings(request: UpdateSettingsRequest):
    """
    更新设置

    Args:
        request (UpdateSettingsRequest): 更新请求体

    Returns:
        Dict[str Any]: 更新结果字典

    Raises:
        HTTPException: 更新失败时抛出 500
    """
    try:
        settings = _load_settings()
        config = get_paths().load_config()
        env_updates: Dict[str, str] = {}

        if request.api:
            # 读取新旧 API 配置
            incoming = request.api.model_dump()
            current_api = settings.get("api", {})

            # 解析目标模型及元数据
            selected_model = incoming.get("selected_model") or current_api.get("selected_model") or _resolve_selected_model(settings, config)
            model_meta = _get_selected_model_meta(config, selected_model)

            # 合并 provider keys 并过滤非法 provider
            provider_keys = current_api.get("provider_keys", {}).copy()
            incoming_keys = incoming.get("provider_keys", {})
            allowed_providers = _allowed_providers(config)
            for provider, value in incoming_keys.items():
                if provider not in allowed_providers:
                    continue
                if not value:
                    provider_keys[provider] = value
                    continue
                if "•" in value:
                    continue
                provider_keys[provider] = value

            provider_keys = {
                provider: value for provider, value in provider_keys.items() if provider in allowed_providers
            }

            selected_provider = model_meta.get("provider", "deepseek")
            old_openai_key = incoming.get("openai_api_key", "")
            if old_openai_key and "•" not in old_openai_key:
                provider_keys[selected_provider] = old_openai_key

            # 收集 .env 变更并同步到进程环境变量
            env_updates: Dict[str, str] = {}
            for provider, value in provider_keys.items():
                if not value or "•" in value:
                    continue
                env_name = PROVIDER_ENV_MAP.get(provider)
                if env_name:
                    env_updates[env_name] = value
                    os.environ[env_name] = value

            silicon_key = incoming.get("silicon_api_key", "")
            if silicon_key and "•" not in silicon_key:
                env_updates["SILICONFLOW_API_KEY"] = silicon_key
                os.environ["SILICONFLOW_API_KEY"] = silicon_key

            embeddings_key = incoming.get("embeddings_api_key", "")
            if embeddings_key and "•" not in embeddings_key:
                env_updates["EMBEDDINGS_API_KEY"] = embeddings_key
                os.environ["EMBEDDINGS_API_KEY"] = embeddings_key

            """tts_key = incoming.get("tts_api_key", "")
            if tts_key and "•" not in tts_key:
                env_updates["TTS_API_KEY"] = tts_key
                os.environ["TTS_API_KEY"] = tts_key
                env_updates["SILICONFLOW_API_KEY"] = tts_key
                os.environ["SILICONFLOW_API_KEY"] = tts_key"""
            if "tts" in incoming and isinstance(incoming["tts"], dict):
                incoming_tts = incoming["tts"]
                providers = incoming_tts.get("providers", {})
                
                for providers_name, provider_cfg in providers.items():
                    if not isinstance(provider_cfg, dict):
                        continue
                    api_key = provider_cfg.pop("api_key", None)
                    if api_key and "•" not in api_key:
                        env_var = f"TTS_{providers_name.upper()}_API_KEY"
                        env_updates[env_var] = api_key
                        provider_cfg["api_key_env"] = env_var
                    # 其他字段保留在 provider_cfg 中
                
                # 合并新的 tts 配置到 incoming 中
                current_tts = settings.get("api", {}).get("tts", {})
                merged_tts = deep_merge(current_tts.copy(), incoming_tts)
                settings.setdefault("api", {})["tts"] = merged_tts

            if env_updates:
                # 合并并写回 .env
                _write_env_file({**_read_env_file(), **env_updates})

            # 保存 API 设置 采用当前模型的 base_url
            settings["api"] = {
                "selected_model": selected_model,
                "openai_model": selected_model,
                "openai_base_url": model_meta.get("base_url", incoming.get("openai_base_url", "https://api.openai.com/v1")),
                "provider_keys": provider_keys,
                "embeddings_model": incoming.get("embeddings_model", current_api.get("embeddings_model", "Pro/BAAI/bge-m3")),
                "embeddings_base_url": incoming.get("embeddings_base_url", current_api.get("embeddings_base_url", "https://api.siliconflow.cn/v1")),
                #"tts_model": incoming.get("tts_model", current_api.get("tts_model", "FunAudioLLM/CosyVoice2-0.5B")),
                #"tts_voice": incoming.get("tts_voice", current_api.get("tts_voice", "Alex_zh")),
                "tts": settings["api"].get("tts", {}) if isinstance(settings["api"].get("tts"), dict) and "tts" in settings["api"] else current_api.get("tts"),
                "temperature": incoming.get("temperature", current_api.get("temperature", 0.7)),
                "max_tokens": incoming.get("max_tokens", current_api.get("max_tokens", 4096)),
                "top_p": incoming.get("top_p", current_api.get("top_p", 1.0)),
                "timeout": incoming.get("timeout", current_api.get("timeout", 60)),
            }

        if request.paths:
            # 保存路径设置
            settings["paths"] = request.paths.model_dump()

        if request.ui:
            # 保存 UI 设置并落盘 theme font 文件
            ui = request.ui.model_dump()
            settings["ui"] = ui
            _save_ui_files(ui)

        # 保存 settings 主文件
        _save_settings(settings)
        if request.paths:
            try:
                # settings 持久化后重设日志落盘目录
                logger.set_file_logging(True, get_paths().logs_dir)
            except Exception:
                pass
            try:
                # settings 持久化后重置音乐服务，避免继续使用旧目录缓存
                from api.services.music_service import reset_music_service
                reset_music_service()
            except Exception:
                pass

        try:
            from api.routes.chat import reload_agent

            # 更新后重载代理配置
            reload_agent()
        except Exception:
            pass

        try:
            from api.services.tts_service import get_tts_service
            get_tts_service().reload_service()
            # 更新后重载 TTS 服务以应用新的密钥与配置
        except Exception:
            pass

        return {"success": True, "message": "Settings updated successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update settings: {e}")


@router.get("/settings/models")
async def list_models():
    """
    获取模型列表与当前模型

    Args:
        None

    Returns:
        Dict[str Any]: 模型列表响应

    Raises:
        HTTPException: 读取失败时抛出 500
    """
    try:
        config = get_paths().load_config()
        settings = _load_settings()
        selected = _resolve_selected_model(settings, config)
        models = _resolve_models(config)
        return {
            "selected_model": selected,
            "models": [_build_model_item(mid, info) for mid, info in models.items()],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list models: {e}")


@router.put("/settings/model")
async def switch_model(request: SwitchModelRequest):
    """
    切换当前模型

    Args:
        request (SwitchModelRequest): 切换请求体

    Returns:
        Dict[str Any]: 切换结果字典

    Raises:
        HTTPException: 模型非法或切换失败时抛出错误
    """
    try:
        config = get_paths().load_config()
        settings = _load_settings()
        models = _resolve_models(config)

        # 校验模型是否存在
        if request.model not in models:
            raise HTTPException(status_code=400, detail=f"Unknown model: {request.model}")

        # 更新 settings 中当前模型信息
        settings.setdefault("api", {})
        settings["api"]["selected_model"] = request.model
        settings["api"]["openai_model"] = request.model
        settings["api"]["openai_base_url"] = models[request.model].get("base_url", "https://api.openai.com/v1")
        _save_settings(settings)

        try:
            from api.routes.chat import reload_agent

            # 切换模型后重载代理
            reload_agent()
        except Exception:
            pass

        return {"success": True, "selected_model": request.model}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to switch model: {e}")


@router.get("/settings/paths")
async def get_paths_info():
    """
    获取关键路径信息

    Args:
        None

    Returns:
        Dict[str str]: 路径信息字典
    """
    paths = get_paths()
    return {
        "root": str(paths.root),
        "sessions_dir": str(paths.sessions_dir),
        "audio_output_dir": str(paths.audio_output_dir),
        "narrative_dir": str(paths.narrative_dir),
        "logs_dir": str(paths.logs_dir),
    }


@router.post("/settings/pick-directory")
async def pick_directory(request: DirectoryPickerRequest):
    """
    打开目录选择器

    Args:
        request (DirectoryPickerRequest): 目录选择请求

    Returns:
        Dict[str str]: 选择结果路径

    Raises:
        HTTPException: 打开失败时抛出 500
    """
    try:
        import tkinter as tk
        from tkinter import filedialog

        # 设置默认初始目录
        initial = request.initial_dir or str(get_paths().root)

        # 创建顶层窗口并打开目录选择器
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
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to open directory picker: {e}")


@router.get("/settings/status", response_model=SystemStatusResponse)
async def get_system_status():
    """
    获取系统可用状态

    Args:
        None

    Returns:
        SystemStatusResponse: 系统状态响应对象
    """
    config = get_paths().load_config()
    settings = _load_settings()
    selected = _resolve_selected_model(settings, config)
    selected_meta = _get_selected_model_meta(config, selected)

    llm_key = _resolve_selected_model_key(selected_meta)
    embeddings_key = os.getenv("EMBEDDINGS_API_KEY", "") or os.getenv("SILICONFLOW_API_KEY", "")
    tts_key = os.getenv("TTS_API_KEY", "") or os.getenv("SILICONFLOW_API_KEY", "")

    # 判定各服务是否已经配置有效密钥
    llm_ready = bool(llm_key and not llm_key.lower().startswith("your_"))
    embeddings_ready = bool(embeddings_key and not embeddings_key.lower().startswith("your_"))
    tts_ready = bool(tts_key and not tts_key.lower().startswith("your_"))

    return SystemStatusResponse(
        backend=True,
        websocket=True,
        tts=tts_ready,
        embeddings=embeddings_ready,
        llm=llm_ready,
    )


@router.get("/settings/theme")
async def get_theme_settings():
    """
    获取主题设置

    Args:
        None

    Returns:
        Dict[str Any]: 主题设置字典
    """
    settings = _load_settings()
    return _load_ui_settings(settings).get("theme", {})


@router.put("/settings/theme")
async def update_theme_settings(theme: UiThemeModel):
    """
    更新主题设置

    Args:
        theme (UiThemeModel): 主题配置对象

    Returns:
        Dict[str Any]: 更新结果字典
    """
    settings = _load_settings()
    ui = _load_ui_settings(settings)
    ui["theme"] = theme.model_dump()
    settings["ui"] = ui
    _save_ui_files(ui)
    _save_settings(settings)
    return {"success": True, "theme": ui["theme"]}


@router.get("/settings/font")
async def get_font_settings():
    """
    获取字体设置

    Args:
        None

    Returns:
        Dict[str Any]: 字体设置字典
    """
    settings = _load_settings()
    return _load_ui_settings(settings).get("font", {})


@router.put("/settings/font")
async def update_font_settings(font: UiFontModel):
    """
    更新字体设置

    Args:
        font (UiFontModel): 字体配置对象

    Returns:
        Dict[str Any]: 更新结果字典
    """
    settings = _load_settings()
    ui = _load_ui_settings(settings)
    ui["font"] = font.model_dump()
    settings["ui"] = ui
    _save_ui_files(ui)
    _save_settings(settings)
    return {"success": True, "font": ui["font"]}


@router.get("/settings/tts", response_model=TtsConfigModel)
async def get_tts_settings():
    """
    获取当前 TTS 配置
    """
    settings = _load_settings()
    tts = settings.get("api", {}).get("tts", {})
    return _mask_tts_config(tts)


@router.post("/settings/tts/switch")
async def switch_tts_provider(body: dict = Body(...)):
    """
    切换当前 TTS 提供商
    
    Args:
        body (dict): 请求体，包含 "provider" 字段指定目标提供商
    """
    provider = body.get("provider")
    if not provider:
        raise HTTPException(400, "provider required")
    settings = _load_settings()
    if "api" not in settings:
        settings["api"] = {}
    if "tts" not in settings["api"]:
        settings["api"]["tts"] = {"provider": provider, "providers": {}}
    else:
        settings["api"]["tts"]["provider"] = provider
    _save_settings(settings)

    from api.services.tts_service import get_tts_service
    get_tts_service().reload_service()

    return {"success": True, "provider": provider}