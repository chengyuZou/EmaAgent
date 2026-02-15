"""
该模块定义 LLM 运行时配置结构

1. 使用数据类描述统一配置字段
2. 支持兼容旧格式配置加载
3. 支持从 `config.json` 与 `settings.json` 合并解析最终生效配置
"""

from dataclasses import dataclass
from typing import Any, Dict, Literal, Optional


@dataclass
class LLMConfig:
    """
    LLM 客户端使用的统一运行时配置

    包含供应商、模型、密钥、接口地址及采样参数等关键字段

    Args:
        provider (Literal): 模型供应商标识
        model (str): 模型名称
        api_key (str): API 密钥
        base_url (str): 接口基础地址
        temperature (float): 温度参数
        max_tokens (int): 最大生成长度
        top_p (float): Top-p 采样参数
        timeout (int): 请求超时秒数

    Returns:
        LLMConfig: 配置实例对象

    Examples:
    >>> cfg = LLMConfig(provider="deepseek", model="deepseek-chat", api_key="sk-xxx")
    >>> cfg.model
    'deepseek-chat'
    """

    provider: Literal["openai", "deepseek", "qwen"] = "deepseek"
    model: str = "deepseek-chat"
    api_key: str = ""
    base_url: str = "https://api.deepseek.com/v1"

    temperature: float = 0.7
    max_tokens: int = 4096
    top_p: float = 1.0
    timeout: int = 60

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "LLMConfig":
        """
        从字典加载配置(兼容旧格式)

        支持两种输入格式
        1. `{"llm": {...}}`
        2. 直接传入 llm 字段字典

        Args:
            data (Dict[str, Any]): 原始配置字典

        Returns:
            LLMConfig: 解析后的配置对象

        Examples:
        >>> cfg = LLMConfig.from_dict({"llm": {"provider": "openai", "model": "gpt-4o"}})
        >>> cfg.provider
        'openai'
        """
        # 兼容旧结构: 优先读取 data["llm"] 否则将 data 视为 llm 配置本体
        llm = data.get("llm", data)
        # 使用默认值补齐缺失字段
        return cls(
            provider=llm.get("provider", "deepseek"),
            model=llm.get("model", "deepseek-chat"),
            api_key=llm.get("api_key", ""),
            base_url=llm.get("base_url", "https://api.deepseek.com/v1"),
            temperature=llm.get("temperature", 0.7),
            max_tokens=llm.get("max_tokens", 4096),
            top_p=llm.get("top_p", 1.0),
            timeout=llm.get("timeout", 60),
        )

    @classmethod
    def from_runtime(cls, config: Dict[str, Any], settings: Optional[Dict[str, Any]] = None) -> "LLMConfig":
        """
        从运行期多来源配置合并得到最终生效参数

        1. `config/config.json`：模型目录与默认值
        2. `config/settings.json`：用户选择模型与覆盖项
        3. 环境变量注入后的密钥（由外层加载逻辑处理）

        Args:
            config (Dict[str, Any]): 主配置字典(通常来自 config.json)
            settings (Optional[Dict[str, Any]]): 用户设置字典(通常来自 settings.json)

        Returns:
            LLMConfig: 最终运行时配置对象

        Examples:
        >>> cfg = LLMConfig.from_runtime({"llm": {}, "llm_models": {}}, {"api": {}})
        >>> isinstance(cfg, LLMConfig)
        True
        """
        # 防御空值 避免后续多次判空
        settings = settings or {}
        llm_defaults = config.get("llm", {})
        model_catalog = config.get("llm_models", {})
        api_settings = settings.get("api", {})

        # 解析当前选中模型 优先级: settings > 默认配置 > 内置兜底
        selected_model = (
            api_settings.get("selected_model")
            or api_settings.get("openai_model")
            or llm_defaults.get("model")
            or "deepseek-chat"
        )

        model_meta = model_catalog.get(selected_model, {}) if isinstance(model_catalog, dict) else {}

        # 供应商解析优先级: 模型元数据 > settings > 默认配置 > 兜底
        provider = (
            model_meta.get("provider")
            or api_settings.get("provider")
            or llm_defaults.get("provider")
            or "deepseek"
        )

        # 接口地址解析优先级: 模型元数据 > settings > 默认配置 > 兜底
        base_url = (
            model_meta.get("base_url")
            or api_settings.get("openai_base_url")
            or llm_defaults.get("base_url")
            or "https://api.deepseek.com/v1"
        )

        # 密钥优先读取模型元数据 其次默认配置
        api_key = (
            model_meta.get("api_key")
            or llm_defaults.get("api_key")
            or ""
        )

        # 汇总最终配置 采样参数优先读取用户设置
        return cls(
            provider=provider,
            model=selected_model,
            api_key=api_key,
            base_url=base_url,
            temperature=api_settings.get("temperature", llm_defaults.get("temperature", 0.7)),
            max_tokens=api_settings.get("max_tokens", llm_defaults.get("max_tokens", 4096)),
            top_p=api_settings.get("top_p", llm_defaults.get("top_p", 1.0)),
            timeout=api_settings.get("timeout", llm_defaults.get("timeout", 60)),
        )
