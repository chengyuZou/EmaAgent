"""
构建Narrative Pipeline所需要的LLM调用函数
使用 OpenAI 的 Chat Completions API 来生成文本回复
"""

from typing import Dict, List, Optional

from openai import AsyncOpenAI

from .exceptions import LLMError
from config.paths import get_paths


def _get_runtime_llm_config() -> Dict:
    paths = get_paths()
    config = paths.load_config()
    settings = paths.load_settings()

    llm_defaults = config.get("llm", {})
    api_settings = settings.get("api", {})
    model_catalog = config.get("llm_models", {})

    selected_model = (
        api_settings.get("selected_model")
        or api_settings.get("openai_model")
        or llm_defaults.get("model")
    )

    model_meta = model_catalog.get(selected_model, {}) if isinstance(model_catalog, dict) else {}

    return {
        "model": selected_model,
        "base_url": model_meta.get("base_url") or api_settings.get("openai_base_url") or llm_defaults.get("base_url"),
        "api_key": model_meta.get("api_key") or llm_defaults.get("api_key", ""),
        "temperature": api_settings.get("temperature", llm_defaults.get("temperature", 0.7)),
    }


async def llm_func(
    prompt: str,
    system_prompt: Optional[str] = None,
    history_messages: List[Dict] = [],
    **kwargs,
) -> str:
    """Call configured chat model."""
    try:
        runtime = _get_runtime_llm_config()
        client = AsyncOpenAI(api_key=runtime["api_key"], base_url=runtime["base_url"])

        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        if history_messages:
            messages.extend(history_messages)
        messages.append({"role": "user", "content": prompt})

        response = await client.chat.completions.create(
            model=runtime["model"],
            messages=messages,
            temperature=kwargs.get("temperature", runtime["temperature"]),
            n=kwargs.get("n", 1),
        )

        return response.choices[0].message.content

    except Exception as e:
        raise LLMError(f"Narrative LLM call failed: {e}")
