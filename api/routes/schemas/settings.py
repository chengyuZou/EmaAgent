"""
设置路由相关的数据模型。
"""

from typing import Dict, List, Optional

from pydantic import BaseModel, Field


class TtsProviderConfig(BaseModel):
    """
    单个 TTS Provider 配置。

    - api_key (Optional[str]): 前端传入的密钥（可能是明文或脱敏值）
    - api_key_env (Optional[str]): 用于持久化的环境变量名
    """

    api_key: Optional[str] = None
    api_key_env: Optional[str] = None

    class Config:
        extra = "allow"


class TtsConfigModel(BaseModel):
    """
    完整 TTS 配置。

    - provider (str): 当前激活的 provider
    - providers (Dict[str, TtsProviderConfig]): 所有 provider 的配置映射
    """

    provider: str = "siliconflow"
    providers: Dict[str, TtsProviderConfig] = Field(default_factory=dict)

    class Config:
        extra = "allow"


class ApiConfigModel(BaseModel):
    """
    /api/settings 中的 API 配置模型。
    """

    selected_model: str = "deepseek-chat"
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    openai_model: str = "gpt-4o"
    provider_keys: Dict[str, str] = Field(default_factory=dict)

    # 保留硅基流动相关字段，用于 embeddings 兼容。
    silicon_api_key: str = ""
    embeddings_api_key: str = ""
    embeddings_model: str = "Pro/BAAI/bge-m3"
    embeddings_base_url: str = "https://api.siliconflow.cn/v1"

    # 兼容旧前端字段（已废弃）。
    tts_api_key: str = Field(default="", deprecated=True)
    tts_model: str = Field(default="FunAudioLLM/CosyVoice2-0.5B", deprecated=True)
    tts_voice: str = Field(default="Alex_zh", deprecated=True)

    # 新版 TTS 结构。
    tts: Optional[TtsConfigModel] = None

    temperature: float = 0.7
    max_tokens: int = 4096
    top_p: float = 1.0
    timeout: int = 60


class PathConfigModel(BaseModel):
    """
    路径配置模型。
    """

    data_dir: str = "./data"
    audio_dir: str = "./data/audio/output"
    log_dir: str = "./logs"
    music_dir: str = "./data/music"


class UiThemeModel(BaseModel):
    """
    主题配置模型。
    """

    mode: str = "light"
    ema_rgb: List[int] = Field(default_factory=lambda: [139, 92, 246])
    accent_rgb: List[int] = Field(default_factory=lambda: [59, 130, 246])
    panel_rgb: List[int] = Field(default_factory=lambda: [255, 255, 255])
    panel_alpha: float = 0.6


class UiFontModel(BaseModel):
    """
    字体配置模型。
    """

    family: str = "'Microsoft YaHei', 'PingFang SC', sans-serif"
    size_scale: float = 1.0
    weight: int = 400


class UiConfigModel(BaseModel):
    """
    UI 配置模型。
    """

    theme: UiThemeModel = Field(default_factory=UiThemeModel)
    font: UiFontModel = Field(default_factory=UiFontModel)


class UpdateSettingsRequest(BaseModel):
    """
    PUT /api/settings 请求体。
    """

    api: Optional[ApiConfigModel] = None
    paths: Optional[PathConfigModel] = None
    ui: Optional[UiConfigModel] = None


class SwitchTtsProviderRequest(BaseModel):
    """
    POST /api/settings/tts/switch 请求体。
    """

    provider: str


class SwitchModelRequest(BaseModel):
    """
    PUT /api/settings/model 请求体。
    """

    model: str


class DirectoryPickerRequest(BaseModel):
    """
    POST /api/settings/pick-directory 请求体。
    """

    initial_dir: str = ""
    title: str = "Select Directory"


class SystemStatusResponse(BaseModel):
    """
    GET /api/settings/status 响应体。
    """

    backend: bool = True
    websocket: bool = True
    tts: bool = False
    embeddings: bool = False
    llm: bool = False
