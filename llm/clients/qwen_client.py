from llm.client import LLMClient
from llm.config import LLMConfig

class QwenClient(LLMClient):
    def __init__(
        self,
        api_key: str,
        model: str = "qwen-plus",
        base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1",
        temperature: float = 0.7,
        max_tokens: int = 4096,
        timeout: int = 60,
    ):

        super().__init__(
            LLMConfig(
                provider="qwen",
                model=model,
                api_key=api_key,
                base_url=base_url,
                temperature=temperature,
                max_tokens=max_tokens,
                timeout=timeout,
            )
        )
