"""
Describe:
该模块封装统一的异步大语言模型客户端，向上提供普通对话、流式输出与工具调用三类能力.

1. 基于 `AsyncOpenAI` 兼容接口统一接入不同提供商.
2. 统一请求参数拼装，减少上层重复逻辑.
3. 提供重试、异常分类与日志记录，增强稳定性.
"""
import asyncio
from typing import List, Dict, Optional, Callable, Awaitable, AsyncIterator

from openai import AsyncOpenAI, OpenAIError, AuthenticationError, RateLimitError, APIError
from openai.types.chat import ChatCompletionMessage
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_random_exponential,
)

from .config import LLMConfig
from utils.logger import logger


class LLMClient:
    """
    统一的异步 LLM 客户端

    1. 负责初始化底层 OpenAI 兼容客户端
    2. 支持非流式与流式文本生成
    3. 支持工具调用 Tool Calls 模式

    Args:
        config (LLMConfig): 运行时模型配置，包括供应商、模型名、密钥和超参数

    Returns:
        None : 实例化后可调用 `chat`、`stream_chat`、`chat_with_tools` 方法

    Examples:
    >>> cfg = LLMConfig(provider="deepseek", model="deepseek-chat", api_key="sk-xxx")
    >>> client = LLMClient(cfg)
    """

    def __init__(self, config: LLMConfig) -> None:
        """
        初始化统一 LLM 客户端实例

        1. 保存配置对象
        2. 创建 OpenAI 兼容异步客户端
        3. 记录初始化日志，便于排障

        Args:
            config (LLMConfig): 完整运行配置
        """
        # 保存配置，供后续请求统一读取
        self.config = config
        # 初始化底层 OpenAI 兼容客户端(可对接多家兼容服务)
        self.client = AsyncOpenAI(
            api_key=config.api_key,
            base_url=config.base_url,
            timeout=config.timeout,
        )
        # 输出关键初始化信息，便于确认当前正在使用的模型与供应商
        logger.info(f"LLM client initialized: {config.provider} | {config.model}")

    def _build_params(
        self,
        messages: List[Dict],
        system_msgs: Optional[List[Dict]] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        **kwargs,
    ) -> Dict:
        """
        构建统一请求参数

        1. 合并系统消息与用户/助手消息
        2. 应用调用级覆盖参数(如 temperature、max_tokens)
        3. 将额外参数透传到底层接口

        Args:
            messages (List[Dict]): 主消息列表
            system_msgs (Optional[List[Dict]]): 系统消息列表，可为空
            temperature (Optional[float]): 采样温度，传入时覆盖默认值
            max_tokens (Optional[int]): 最大生成长度，传入时覆盖默认值
            **kwargs (Any): 其他透传参数

        Returns:
            params (Dict): 可直接传给 `chat.completions.create` 的参数字典

        示例：
        >>> params = client._build_params(messages=[{"role": "user", "content": "你好"}])
        >>> isinstance(params, dict)
        True
        """
        # 将系统消息放在前面，保持对话上下文结构一致
        all_messages = (system_msgs or []) + messages
        # 统一输出请求参数，调用级参数优先于配置默认值，额外参数直接透传
        return {
            "model": self.config.model,
            "messages": all_messages,
            "temperature": temperature if temperature is not None else self.config.temperature,
            "max_tokens": max_tokens if max_tokens is not None else self.config.max_tokens,
            "top_p": self.config.top_p,
            **kwargs,
        }
    
    # `retry` 装饰器实现自动重试机制，针对 OpenAIError、ValueError 和其他异常进行分类重试，增强稳定性
    @retry(
        wait=wait_random_exponential(min=1, max=60),
        stop=stop_after_attempt(3),
        retry=retry_if_exception_type((OpenAIError, Exception, ValueError)),
    )
    async def chat(
        self,
        messages: List[Dict],
        system_msgs: Optional[List[Dict]] = None,
        stream: bool = True,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        on_token_callback: Optional[Callable[[str], Awaitable[None]]] = None,
        emit_stdout: bool = False,
        **kwargs,
    ) -> str:
        """
        执行一次对话请求并返回完整文本

        1. 支持非流式：直接获取完整响应
        2. 支持流式：逐 token 收集后拼接为完整响应
        3. 支持 token 回调，可用于前端流式显示
        4. 内置异常分类与重试策略

        Args:
            messages (List[Dict]): 对话消息列表
            system_msgs (Optional[List[Dict]]): 系统消息列表
            stream (bool): 是否启用流式输出
            temperature (Optional[float]): 调用级温度参数
            max_tokens (Optional[int]): 调用级最大生成长度
            on_token_callback (Optional[Callable[[str], Awaitable[None]]]): 流式 token 回调函数
            emit_stdout (bool): 是否同步输出到标准输出
            **kwargs (Any): 额外透传参数

        Returns:
            str: 最终完整回复文本

        Raises:
            ValueError: 响应为空或格式不合法
            OpenAIError: 底层接口错误(认证、限流、API 错误等)
            Exception: 其他未预期异常

        Examples:
        >>> text = await client.chat(messages=[{"role": "user", "content": "写一句话"}], stream=False)
        """
        try:
            # 先生成统一请求参数，确保流式与非流式分支共用同一套配置逻辑
            params = self._build_params(
                messages=messages,
                system_msgs=system_msgs,
                temperature=temperature,
                max_tokens=max_tokens,
                **kwargs,
            )

            # 非流式: 一次性请求并直接返回内容
            if not stream:
                response = await self.client.chat.completions.create(**params, stream=False)
                if not response.choices or not response.choices[0].message.content:
                    raise ValueError("LLM返回了无效或者空的响应")
                return response.choices[0].message.content

            # 可选: 将流式 token 同步打印到终端
            if emit_stdout:
                print("Ema: ", end="", flush=True)

            # 流式: 逐 token 收集 最后再拼接成完整文本返回
            chunks: List[str] = []
            async for token in self.stream_chat(
                messages=messages,
                system_msgs=system_msgs,
                temperature=temperature,
                max_tokens=max_tokens,
                on_token_callback=on_token_callback,
                **kwargs,
            ):
                chunks.append(token)
                if emit_stdout:
                    print(token, end="", flush=True)

            # 流式输出结束后补换行 避免污染终端提示符
            if emit_stdout:
                print()

            # 拼接并校验最终响应 防止返回空字符串
            full_response = "".join(chunks).strip()
            if not full_response:
                raise ValueError("LLM 流式输出返回了空的响应")
            return full_response

        # 参数/响应校验类错误 直接上抛给调用方处理
        except ValueError:
            logger.exception("无效响应错误")
            raise
        # OpenAI 兼容接口异常 记录细分类别后上抛
        except OpenAIError as oe:
            logger.exception("OpenAI API 错误")
            if isinstance(oe, AuthenticationError):
                logger.error("认证失败 请检查 API 密钥是否正确。")
            elif isinstance(oe, RateLimitError):
                logger.error("请求频率超出限制。")
            elif isinstance(oe, APIError):
                logger.error(f"API 错误: {oe}")
            raise
        # 其他未归类异常 统一记录并上抛
        except Exception as e:
            logger.exception(f"未预期错误: {e}")
            raise

    async def stream_chat(
        self,
        messages: List[Dict],
        system_msgs: Optional[List[Dict]] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        on_token_callback: Optional[Callable[[str], Awaitable[None]]] = None,
        **kwargs,
    ) -> AsyncIterator[str]:
        """
        发起流式请求并按 token 产出文本片段

        1. 调用流式接口获取增量结果
        2. 自动过滤空 chunk 与空 token
        3. 支持 token 级回调，便于联动前端显示或 TTS

        Args:
            messages (List[Dict]): 对话消息列表
            system_msgs (Optional[List[Dict]]): 系统消息列表
            temperature (Optional[float]): 调用级温度参数
            max_tokens (Optional[int]): 调用级最大生成长度
            on_token_callback (Optional[Callable[[str], Awaitable[None]]]): token 回调
            **kwargs (Any): 额外透传参数

        Returns:
            AsyncIterator[str]: 按顺序产出的 token 序列

        Examples:
        >>> async for tk in client.stream_chat(messages=[{"role": "user", "content": "你好"}]):
        ...     print(tk)
        """
        # 构建流式请求参数
        params = self._build_params(
            messages=messages,
            system_msgs=system_msgs,
            temperature=temperature,
            max_tokens=max_tokens,
            **kwargs,
        )

        # 发起流式请求并逐 chunk 解析
        response = await self.client.chat.completions.create(**params, stream=True)
        async for chunk in response:
            # 无可用候选时跳过
            if not chunk.choices:
                continue
            # 提取增量文本 空文本直接忽略
            token = chunk.choices[0].delta.content or ""
            if not token:
                continue

            # 如存在回调则执行 兼容协程与普通函数
            if on_token_callback:
                result = on_token_callback(token)
                if asyncio.iscoroutine(result):
                    await result

            # 将 token 返回给上层调用者
            yield token

    @retry(
        wait=wait_random_exponential(min=1, max=60),
        stop=stop_after_attempt(6),
        retry=retry_if_exception_type((OpenAIError, Exception, ValueError)),
    )
    async def chat_with_tools(
        self,
        messages: List[Dict],
        tools: List[Dict],
        system_msgs: Optional[List[Dict]] = None,
        tool_choice: str = "auto",
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        timeout: int = 300,
        **kwargs,
    ) -> ChatCompletionMessage | None:
        """
        通过工具调用模式发起一次非流式请求

        1. 校验工具列表结构是否合法
        2. 调用 `tools + tool_choice` 机制获取模型回复
        3. 返回首个消息对象(可能含 tool_calls)

        Args:
            messages (List[Dict]): 对话消息列表
            tools (List[Dict]): 工具定义列表
            system_msgs (Optional[List[Dict]]): 系统消息列表
            tool_choice (str): 工具选择策略，默认 `auto`
            temperature (Optional[float]): 调用级温度参数
            max_tokens (Optional[int]): 调用级最大生成长度
            timeout (int): 本次请求超时秒数
            **kwargs (Any): 额外透传参数

        Returns:
            ChatCompletionMessage | None: 首个回复消息 无有效内容时返回 `None`

        Raises:
              ValueError: 工具定义结构不合法
              OpenAIError: 底层接口错误
              Exception: 其他未预期异常

        Examples:
        >>> msg = await client.chat_with_tools(messages=[{"role": "user", "content": "查天气"}], tools=[])
        """
        try:
            # 组装完整消息上下文(系统消息在前)
            all_messages = (system_msgs or []) + messages

            # 对工具参数做基础结构校验 减少运行期报错
            if tools:
                for tool in tools:
                    if not isinstance(tool, dict) or "type" not in tool:
                        raise ValueError("每一个工具定义必须是包含 'type' 字段的字典")

            # 工具调用模式固定为非流式 便于完整解析 tool_calls
            completion: ChatCompletionMessage = await self.client.chat.completions.create(
                model=self.config.model,
                messages=all_messages,
                tools=tools,
                tool_choice=tool_choice,
                temperature=temperature if temperature is not None else self.config.temperature,
                max_tokens=max_tokens if max_tokens is not None else self.config.max_tokens,
                top_p=self.config.top_p,
                timeout=timeout,
                stream=False,
                **kwargs,
            )

            # 响应为空或格式异常时返回 None 让上层决定兜底策略
            if not completion.choices or not completion.choices[0].message:
                logger.warning("LLM 返回了无效或空的响应 chat_with_tools 将返回 None")
                return None

            # 返回首个消息对象(含文本或工具调用信息)
            return completion.choices[0].message

        # 参数校验错误 记录后上抛
        except ValueError as ve:
            logger.error(f"在 chat_with_tools 中检测到参数校验错误: {ve}")
            raise
        # OpenAI 兼容接口异常 按类型记录
        except OpenAIError as oe:
            logger.exception("在 chat_with_tools 中发生 OpenAI API 错误")
            if isinstance(oe, AuthenticationError):
                logger.error("认证失败 请检查 API 密钥是否正确")
            elif isinstance(oe, RateLimitError):
                logger.error("请求频率超出限制")
            elif isinstance(oe, APIError):
                logger.error(f"API 错误: {oe}")
            raise
        # 其余异常统一记录。
        except Exception as e:
            logger.exception(f"在 chat_with_tools 中发生未预期异常: {e}")
            raise

    def __repr__(self) -> str:
        """
        返回便于调试的实例字符串表示

        展示当前客户端使用的供应商与模型名 便于日志输出与排障

        Examples:
        >>> repr(client)
        'LLMClient(provider=deepseek, model=deepseek-chat)'
        """
        # 用简短结构展示关键配置 便于日志与调试输出
        return f"LLMClient(provider={self.config.provider}, model={self.config.model})"
