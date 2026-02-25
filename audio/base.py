from abc import ABC, abstractmethod
import re
from typing import Optional
import os


def looks_like_env_key_name(value: str) -> bool:
    """
    判断字符串是否看起来像环境变量名（全大写，通常以 _API_KEY 结尾）
    """
    raw = str(value or "").strip()
    return bool(raw and raw.upper().endswith("_API_KEY") and raw.upper() == raw)


def resolve_provider_api_key(cfg: dict) -> str:
    """
    解析 provider API Key，支持 api_key_env 与 api_key 两种配置方式

    Example:
    ```
        cfg={"api_key_env":"SILICONFLOW_API_KEY","api_key":"sk-live-siliconflow"}
        => 返回环境变量 SILICONFLOW_API_KEY 的值（如果存在且非空），否则返回 sk-live-siliconflow
    ```
    """
    if not isinstance(cfg, dict):
        return ""

    env_name = str(cfg.get("api_key_env") or "").strip()
    raw_key = str(cfg.get("api_key") or "").strip()

    if env_name:
        env_val = os.getenv(env_name, "")
        if env_val:
            return env_val

    if looks_like_env_key_name(raw_key):
        env_val = os.getenv(raw_key, "")
        if env_val:
            return env_val

    return raw_key


# 动作描述标记，例如（微笑）(叹气) *nod* **smile**
ACTION_PAREN_CN_REGEX = re.compile(r"（[^（）\n]{0,80}）")
ACTION_PAREN_EN_REGEX = re.compile(r"\([^()\n]{0,80}\)")
ACTION_STAR_BOLD_REGEX = re.compile(r"\*\*[^*\n]{1,80}\*\*")
ACTION_STAR_REGEX = re.compile(r"(?<!\*)\*[^*\n]{1,80}\*(?!\*)")


def strip_action_text(text: str) -> str:
    """
    去除常见动作标记文本

    支持格式:
    - （动作）
    - (action)
    - *action*
    - **action**
    """
    if not text:
        return ""

    result = text
    # 多轮替换以处理相邻或嵌套标记
    for _ in range(4):
        next_result = ACTION_PAREN_CN_REGEX.sub(" ", result)
        next_result = ACTION_PAREN_EN_REGEX.sub(" ", next_result)
        next_result = ACTION_STAR_BOLD_REGEX.sub(" ", next_result)
        next_result = ACTION_STAR_REGEX.sub(" ", next_result)
        if next_result == result:
            break
        result = next_result

    result = re.sub(r"[ \t]{2,}", " ", result)
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result.strip()


def normalize_tts_text(text: str) -> str:
    """
    规范化用于 TTS 的文本，统一清理 markdown 与动作描述。
    """
    if not text:
        return ""

    result = text
    # 兼容字面量换行转义，避免 "\n" 被保留为普通字符
    result = result.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\r", "\n")
    # 去除动作描述文本
    result = strip_action_text(result)
    # 去除行内代码
    result = re.sub(r"`[^`\n]*`", " ", result)
    # 去除图片 markdown
    result = re.sub(r"!\[[^\]]*]\([^)]+\)", " ", result)
    # 链接 markdown 仅保留可见文本
    result = re.sub(r"\[([^\]]+)]\([^)]+\)", r"\1", result)
    # 去除标题、列表、引用标记
    result = re.sub(r"^\s*#{1,6}\s*", "", result, flags=re.MULTILINE)
    result = re.sub(r"^\s*[-*+]\s+", "", result, flags=re.MULTILINE)
    result = re.sub(r"^\s*\d+\.\s+", "", result, flags=re.MULTILINE)
    result = re.sub(r"^\s*>\s?", "", result, flags=re.MULTILINE)
    # 去除常见加粗删除线标记
    result = result.replace("**", "").replace("__", "").replace("~~", "")
    # 归一化空白与空行
    result = re.sub(r"[ \t]+", " ", result)
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result.strip()


def has_speakable_content(text: str) -> bool:
    """
    判断文本是否包含可发音字符（中英文或数字）。
    """
    return bool(re.search(r"[A-Za-z0-9\u4e00-\u9fff]", text or ""))


class TTSClient(ABC):
    """TTS 客户端"""

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

    def _looks_like_env_key_name(self, value: str) -> bool:
        """
        判断字符串是否看起来像一个环境变量名（全大写，通常以 _API_KEY 结尾）
        """
        return looks_like_env_key_name(value)
    
    def _resolve_provider_api_key(self, cfg: dict) -> str:
        """
        解析提供者 API Key 的值 支持直接配置和环境变量两种方式
            - 优先解析 api_key_env 指定的环境变量
            - 其次如果 api_key 看起来像环境变量名也尝试解析
            - 最后回退 api_key 原始值
            - 解析失败时返回空字符串
        """
        return resolve_provider_api_key(cfg)
