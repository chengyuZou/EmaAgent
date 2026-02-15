"""
ReAct Agent 核心模块

该模块实现思考与行动循环 并统一管理工具调用与中间状态写回
"""

import json
from datetime import datetime
from typing import Any, Dict, List

from llm.client import LLMClient
from memory.schema import (
    AgentRuntimeState,
    AgentStatus,
    AssistantMessage,
    Session,
    SystemMessage,
    ToolMessage,
    UserMessage,
)
from prompts.agent_system_prompt import AGENT_SYSTEM_PROMPT
from tools.builtin.code_exec import CodeExecutorTool
from tools.builtin.file_ops import FileOperationTool
from tools.builtin.terminal_exec import TerminalExecutorTool
from tools.builtin.weather import WeatherTool
from tools.file_analysis.CodeAnalyzer import CodeAnalysisTool
from tools.file_analysis.DocumentAnalyzer import DocumentAnalyzerTool
from tools.search.arxiv_paper import ArxivPaperTool
from tools.search.baidusearch import BaiduSearchTool
from tools.time import TimeTool
from tools.tool_collection import ToolCollection
from tools.webscraper import WebScraperTool
from utils.logger import logger


class ReActAgent:
    """
    ReAct 推理执行器

    该类围绕 AgentRuntimeState 执行思考与行动循环
    不直接负责会话生命周期与持久化
    """

    def __init__(self, llm_client: LLMClient, max_steps: int = 20):
        """
        初始化 ReAct Agent 与工具集合

        Args:
            llm_client (LLMClient): LLM 客户端实例
            max_steps (int): 最大推理步数

        Returns:
            None
        """
        logger.info("初始化 ReAct Agent...")

        self.llm_client = llm_client
        self.max_steps = max_steps
        self.tools = ToolCollection(
            FileOperationTool(),
            DocumentAnalyzerTool(),
            BaiduSearchTool(),
            ArxivPaperTool(),
            CodeExecutorTool(),
            TerminalExecutorTool(),
            WeatherTool(),
            CodeAnalysisTool(),
            TimeTool(),
            WebScraperTool(),
        )

        logger.info(f"Agent 初始化完成，工具: {[t.name for t in self.tools.tools]}")

    async def run(self, user_input: str, session: Session) -> AgentRuntimeState:
        """
        执行一次完整 ReAct 任务

        该方法会构建运行状态并循环执行 think act 直到完成或出错

        Args:
            user_input (str): 用户输入文本
            session (Session): 会话对象

        Returns:
            AgentRuntimeState: 包含最终答案 工具结果 与状态信息

        Raises:
            Exception: 内部异常会被捕获并写入 state.error 不向外抛出
        """
        # 将用户输入写入会话历史
        session.messages.append(UserMessage(content=user_input))
        llm_messages = self._build_llm_messages(session)

        state = AgentRuntimeState(
            session=session,
            user_input=user_input,
            messages=llm_messages,
            max_steps=self.max_steps,
            start_time=datetime.now(),
            status=AgentStatus.IDLE,
        )

        logger.info(f"开始执行任务: {state.user_input[:100]}...")

        try:
            # 主循环：思考 -> 行动 -> 更新状态 直到完成或达到步数限制
            while not state.is_finished and state.current_step < state.max_steps:
                state.current_step += 1
                logger.info(f"步骤 {state.current_step}/{state.max_steps}")

                # 思考阶段：请求 LLM 输出下一步行动或最终答案
                state = await self._think(state)
                if state.current_thought:
                    logger.info(f"思考: {state.current_thought}")

                # 行动阶段：执行工具调用并写回结果
                if state.current_action and state.status != AgentStatus.FINISHED:
                    state.status = AgentStatus.ACTING
                    state = await self._act(state)

                # 如果没有工具调用 但也未生成最终答案 则认为任务完成
                else:
                    state.status = AgentStatus.FINISHED
                    break

            # 超过最大步数限制但未完成任务 也强制结束并写入提示
            if state.current_step >= state.max_steps and not state.final_answer:
                state.final_answer = "达到最大步数限制，任务未能完成。"
                state.status = AgentStatus.FINISHED

        except Exception as e:
            logger.error(f"Agent 执行失败: {e}", exc_info=True)
            state.error = str(e)
            state.status = AgentStatus.ERROR

        # 记录结束时间与总耗时
        state.end_time = datetime.now()
        logger.info(f"任务完成，耗时: {state.duration:.2f}s")
        return state

    def _build_llm_messages(self, session: Session) -> list:
        """
        构建 LLM 输入消息列表

        结构为系统提示加会话上下文

        Args:
            session (Session): 当前会话对象

        Returns:
            list: LLM 输入消息对象列表
        """
        # 系统提示 + 会话历史消息构成 LLM 输入
        messages = [SystemMessage(content=AGENT_SYSTEM_PROMPT)]
        messages.extend(session.get_context_for_llm())
        return messages

    async def _think(self, state: AgentRuntimeState) -> AgentRuntimeState:
        """
        执行思考阶段

        该阶段向 LLM 请求下一步 并解析 tool_calls 或最终答案

        Args:
            state (AgentRuntimeState): 当前运行状态

        Returns:
            AgentRuntimeState: 更新后的运行状态
        """
        logger.info("思考中...")
        # 重置当前思考状态
        state.status = AgentStatus.THINKING
        state.current_thought = ""
        state.current_tool_calls = []
        state.current_action = ""

        # 将当前消息状态转换为 LLM 输入格式
        messages = [msg.to_dict() for msg in state.messages]
        logger.info(f"LLM 输入: {messages}")

        # 请求 LLM 输出下一步行动或最终答案
        response = await self.llm_client.chat_with_tools(
            messages=messages,
            tools=self.tools.to_params(),
        )

        # 解析 LLM 输出的内容与工具调用
        content = response.content if hasattr(response, "content") else response.get("content", "")
        tool_calls = (
            response.tool_calls if hasattr(response, "tool_calls") else response.get("tool_calls")
        )

        # 如果 LLM 输出了工具调用 则写入当前状态与消息历史 否则认为生成了最终答案
        if tool_calls:
            serializable_tool_calls = self._parse_tool_call(tool_calls)
            state.current_thought = content or ""
            state.current_tool_calls = serializable_tool_calls
            state.current_action = serializable_tool_calls[0]["function"]["name"]

            # 将思考内容与工具调用写入消息历史
            assistant_msg = AssistantMessage(content=content, tool_calls=serializable_tool_calls)
            state.messages.append(assistant_msg)
            state.session.messages.append(assistant_msg)

            tool_names = ", ".join(tc["function"]["name"] for tc in serializable_tool_calls)
            logger.info(f"决定调用工具: {tool_names}")
        else:
            state.final_answer = content or ""
            state.status = AgentStatus.FINISHED
            logger.info("生成初步答案")
            logger.info(f"回答内容: {state.final_answer}")

        return state

    async def _act(self, state: AgentRuntimeState) -> AgentRuntimeState:
        """
        执行动作阶段

        该阶段遍历当前 tool_calls 并执行工具

        然后将输出写入消息与工具结果列表

        Args:
            state (AgentRuntimeState): 当前运行状态

        Returns:
            AgentRuntimeState: 更新后的运行状态
        """
        state.status = AgentStatus.ACTING

        # 遍历当前工具调用列表 依次执行工具并写回结果
        for tool_call in state.current_tool_calls:
            if hasattr(tool_call, "function"):
                tool_name = tool_call.function.name
                tool_id = tool_call.id
                arguments_str = tool_call.function.arguments
            else:
                tool_name = tool_call["function"]["name"]
                tool_id = tool_call["id"]
                arguments_str = tool_call["function"]["arguments"]

            # 解析工具参数 支持 dict 与 JSON 字符串输入 非法 JSON 会回退为 input 字段
            arguments: Dict[str, Any] = self._parse_arguments(arguments_str)
            state.current_action = tool_name
            logger.info(f"执行工具: {tool_name}")

            try:
                # 执行工具并获取结果
                result = await self.tools.execute(name=tool_name, tool_input=arguments)
                result_content = result.output or ""
                success = not bool(result.error)

                # 根据执行结果构建输出内容 如果有错误则标记失败并写入错误信息
                if result.error:
                    err = result.error.strip()
                    result_content = f"[工具执行失败]\n{err}" if err else "[工具执行失败]"
                    logger.warning(f"工具执行返回错误: {tool_name} - {result.error}")
                else:
                    logger.info(f"工具执行成功: {tool_name}")

                # 将工具输出写入消息历史与工具结果列表 供后续思考阶段使用
                tool_msg = ToolMessage(content=result_content, name=tool_name, tool_call_id=tool_id)
                state.messages.append(tool_msg)
                state.session.messages.append(tool_msg)

                # 工具结果记录结构包含工具名称 成功标志 输出内容 以及可选错误信息
                item: Dict[str, Any] = {
                    "tool_name": tool_name,
                    "success": success,
                    "output": result_content,
                }
                if result.error:
                    item["error"] = result.error
                state.tool_results.append(item)

                logger.info(f"工具输出: {result_content}")

            # 捕获工具执行中的任何异常 将错误信息写入消息历史与工具结果列表 供后续思考阶段使用
            except Exception as e:
                logger.error(f"工具执行异常: {tool_name} - {e}", exc_info=True)
                error_content = f"[工具执行异常]\n{e}"
                tool_msg = ToolMessage(content=error_content, name=tool_name, tool_call_id=tool_id)
                state.messages.append(tool_msg)
                state.session.messages.append(tool_msg)
                state.tool_results.append(
                    {
                        "tool_name": tool_name,
                        "success": False,
                        "error": str(e),
                    }
                )

        return state

    def _parse_tool_call(self, tool_calls: Any) -> List[Dict[str, Any]]:
        """
        统一解析 tool_calls 为可序列化字典

        Args:
            tool_calls (Any): 原始 tool_calls 数据

        Returns:
            List[Dict[str, Any]]: 标准化后的 tool_calls 列表
        """
        # 支持多种输入格式 包括具有 model_dump 或 dict 方法的对象 以及原生 dict
        serializable_tool_calls: List[Dict[str, Any]] = []
        # 遍历原始 tool_calls 列表 依次解析每个工具调用对象 优先使用 model_dump 或 dict 方法获取可序列化数据 如果都没有 则尝试从属性构建字典
        for tc in tool_calls:
            # 优先使用 model_dump 或 dict 方法获取可序列化数据 如果都没有 则尝试从属性构建字典
            if hasattr(tc, "model_dump"):
                serializable_tool_calls.append(tc.model_dump())
            # 如果对象具有 dict 方法 则调用该方法获取可序列化数据
            elif hasattr(tc, "dict"):
                serializable_tool_calls.append(tc.dict())
            # 如果已经是字典类型 则直接添加到结果列表中
            elif isinstance(tc, dict):
                serializable_tool_calls.append(tc)
            # 如果以上方法都不可用 则尝试从对象属性构建一个标准化的字典 该字典包含工具调用的 id 类型 以及函数名称和参数等信息
            else:
                serializable_tool_calls.append(
                    {
                        "id": tc.id,
                        "type": getattr(tc, "type", "function"),
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        },
                    }
                )

        return serializable_tool_calls

    def _parse_arguments(self, arguments: Any) -> Dict[str, Any]:
        """
        解析工具参数为字典

        支持 dict 与 JSON 字符串输入
        非法 JSON 字符串会回退为 input 字段

        Args:
            arguments (Any): 原始参数对象

        Returns:
            Dict[str, Any]: 解析后的参数字典
        """
        # 支持 dict 与 JSON 字符串输入 非法 JSON 会回退为 input 字段
        if isinstance(arguments, dict):
            return arguments
        # 如果参数是字符串类型 则尝试解析为 JSON 如果解析失败 则将原始字符串作为 input 字段返回 以兼容简单文本输入的工具参数
        if isinstance(arguments, str):
            try:
                return json.loads(arguments)
            except json.JSONDecodeError:
                return {"input": arguments}
        return {}
