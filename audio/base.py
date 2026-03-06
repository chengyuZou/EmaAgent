from __future__ import annotations

import os
import re
from abc import ABC, abstractmethod
from typing import Optional


def looks_like_env_key_name(value: str) -> bool:
    """
    判断字符串是否像环境变量名（全大写，通常以 `_API_KEY` 结尾）。

    Args:
        value (str): 待判断字符串。

    Returns:
        bool: 是否像环境变量名。
    """
    raw = str(value or "").strip()
    return bool(raw and raw.upper().endswith("_API_KEY") and raw.upper() == raw)


def resolve_provider_api_key(cfg: dict) -> str:
    """
    解析 provider API Key。

    优先级：
    1. `api_key_env` 对应的系统环境变量
    2. `api_key` 若看起来是环境变量名，则读取其对应环境变量
    3. `api_key` 原始值

    Args:
        cfg (dict): provider 配置字典。

    Returns:
        str: 解析后的 API Key（可能为空字符串）。
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


# 动作描述标记：仅清理括号动作，不清理 **加重文本** 的内容
ACTION_PAREN_CN_REGEX = re.compile(r"（[^（）\n]{0,80}）")
ACTION_PAREN_EN_REGEX = re.compile(r"\([^()\n]{0,80}\)")


def strip_action_text(text: str) -> str:
    """
    去除常见动作标记文本（括号动作）。

    支持格式：
    - `（动作）`
    - `(action)`

    注意：
    - 不处理 `**加重文本**`，避免把正文内容误删。

    Args:
        text (str): 原始文本。

    Returns:
        str: 去除动作后的文本。
    """
    if not text:
        return ""

    result = text
    for _ in range(4):
        next_result = ACTION_PAREN_CN_REGEX.sub(" ", result)
        next_result = ACTION_PAREN_EN_REGEX.sub(" ", next_result)
        if next_result == result:
            break
        result = next_result

    result = re.sub(r"[ \t]{2,}", " ", result)
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result.strip()


def normalize_tts_text(text: str) -> str:
    """
    规范化用于 TTS 的文本。

    目标：
    - 去除动作括号与无关标记
    - 保留正文语义
    - `**加重文本**` 仅去掉星号，保留内容

    Args:
        text (str): 原始文本。

    Returns:
        str: 可用于 TTS 的清洗文本。
    """
    if not text:
        return ""

    result = text
    # 兼容字面量换行转义，避免 "\n" 被当普通字符读出
    result = result.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\r", "\n")

    # 去除动作描述（括号）
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

    # 保留内容，仅去除 markdown 强调外壳
    result = re.sub(r"\*\*([^*\n]+)\*\*", r"\1", result)
    result = re.sub(r"__([^_\n]+)__", r"\1", result)
    result = re.sub(r"~~([^~\n]+)~~", r"\1", result)
    result = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"\1", result)
    result = re.sub(r"(?<!_)_([^_\n]+)_(?!_)", r"\1", result)

    # 归一化空白与空行
    result = re.sub(r"[ \t]+", " ", result)
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result.strip()


def has_speakable_content(text: str) -> bool:
    """
    判断文本是否包含可发音字符（中文、英文或数字）。

    Args:
        text (str): 待判断文本。

    Returns:
        bool: 是否存在可朗读内容。
    """
    return bool(re.search(r"[A-Za-z0-9\u4e00-\u9fff]", text or ""))


class TTSClient(ABC):
    """TTS 客户端基类。"""

    @abstractmethod
    def generate(self, text: str) -> Optional[str]:
        """
        生成单段语音，返回生成文件绝对路径。

        Args:
            text (str): 待合成文本。

        Returns:
            Optional[str]: 音频路径；失败返回 `None`。
        """
        raise NotImplementedError

    def initialize(self):
        """初始化（可选，如上传参考音频）。"""
        return None

    def reset(self):
        """重置状态（可选，如重新上传参考音频）。"""
        return None

    def _looks_like_env_key_name(self, value: str) -> bool:
        """
        判断字符串是否像环境变量名（全大写，通常以 `_API_KEY` 结尾）。

        Args:
            value (str): 待判断字符串。

        Returns:
            bool: 判断结果。
        """
        return looks_like_env_key_name(value)

    def _resolve_provider_api_key(self, cfg: dict) -> str:
        """
        解析提供者 API Key（兼容环境变量和直填值）。

        Args:
            cfg (dict): provider 配置字典。

        Returns:
            str: 解析后的 API Key。
        """
        return resolve_provider_api_key(cfg)
