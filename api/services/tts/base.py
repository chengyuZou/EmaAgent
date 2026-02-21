from abc import ABC, abstractmethod
from typing import Optional


class BaseTTSProvider(ABC):
    """TTS provider 抽象基类"""

    @abstractmethod
    def generate(self, text: str) -> Optional[str]:
        """
        生成单段语音，返回生成的音频文件绝对路径。
        失败时返回 None。
        """
        pass

    def initialize(self):
        """初始化 (可选, 如上传参考音频)"""
        pass

    def reset(self):
        """重置状态 (可选, 如重新上传参考音频)"""
        pass
