from typing import Dict, Any, Optional, Type
from audio.base import TTSClient
from audio.clients.siliconflow import SiliconflowTTSClient
from audio.clients.vits_simple import VitsSimpleApiTTSClient
from utils.logger import logger


class TTSFactory:
    """
    TTS provider 工厂类
    """

    _providers = {
        "siliconflow": SiliconflowTTSClient,
        "vits_simple": VitsSimpleApiTTSClient,
    }

    @classmethod
    def create_provider(
        cls, provider_name: str, config: Dict[str, Any]
    ) -> Optional[TTSClient]:
        """
        根据 provider 名称和配置创建 provider 实例
        """
        provider_cls = cls._providers.get(provider_name.lower())
        if not provider_cls:
            logger.error(f"[TTS Factory] 未知的 TTS 提供者: {provider_name}")
            # 默认 fallback 到 siliconflow
            provider_cls = SiliconflowTTSClient

        try:
            return provider_cls(config)
        except Exception as e:
            logger.error(f"[TTS Factory] 创建 TTS 提供者 {provider_name} 失败: {e}")
            return None

    @classmethod
    def register_provider(cls, name: str, provider_cls: Type[TTSClient]):
        """注册新的 provider

        Args:
            name (str): provider 名称
            provider_cls (Type[TTSClient]): provider 类
        """
        cls._providers[name.lower()] = provider_cls
