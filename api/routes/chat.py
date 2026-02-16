"""
聊天路由模块

该模块提供 HTTP 对话 WebSocket 流式对话 与附件上传接口
"""

import asyncio
import re
import uuid
from pathlib import Path
from typing import Optional, List, Dict, Any
from urllib.parse import quote

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException, UploadFile, File, Form
from pydantic import BaseModel

from agent.EmaAgent import EmaAgent
from config.paths import get_paths
from utils.logger import logger

router = APIRouter()

_agent: Optional[EmaAgent] = None

# 分离文本的句子边界正则 支持中文句号问号感叹号换行等
SENTENCE_SPLIT_REGEX = re.compile(r"[。！？?!\n]")
# 支持的文件文本预览扩展名
TEXT_EXTENSIONS = {".txt", ".md", ".py", ".json", ".yaml", ".yml", ".csv", ".log", ".ini"}
ATTACHMENT_EXCERPT_LIMIT = 12000
# 代码块标记 用于分离可见文本与代码内容 避免 TTS 朗读代码
FENCE_MARKER = "```"
# 动作描述标记 例如 （微笑） (叹气) *nod* **smile**
ACTION_PAREN_CN_REGEX = re.compile(r"（[^（）\n]{0,80}）")
ACTION_PAREN_EN_REGEX = re.compile(r"\([^()\n]{0,80}\)")
ACTION_STAR_BOLD_REGEX = re.compile(r"\*\*[^*\n]{1,80}\*\*")
ACTION_STAR_REGEX = re.compile(r"(?<!\*)\*[^*\n]{1,80}\*(?!\*)")


def get_agent() -> EmaAgent:
    """
    获取全局 EmaAgent 实例
    """
    global _agent
    # 延迟初始化代理对象
    if _agent is None:
        _agent = EmaAgent(server_mode=True)
    return _agent


def reload_agent() -> None:
    """
    重载代理与语音配置
    """
    global _agent
    if _agent is not None:
        # 代理已存在时刷新内部配置
        _agent.reload_config()

    from api.services.tts_service import get_tts_service

    # 刷新 TTS 音色缓存 强制重新上传参考音频
    get_tts_service().reset_voice()


def generate_audio(text: str) -> Optional[str]:
    """
    生成单段音频文件

    Args:
        text (str): 待合成文本

    Returns:
        Optional[str]: 音频文件路径 失败时返回 None
    """
    from api.services.tts_service import get_tts_service

    return get_tts_service().generate(text)


def merge_audio_chunks(file_paths: List[str]) -> Optional[str]:
    """
    合并音频分段文件

    Args:
        file_paths (List[str]): 分段音频路径列表

    Returns:
        Optional[str]: 合并后音频路径 失败时返回 None
    """
    from api.services.tts_service import get_tts_service

    return get_tts_service().merge_audio_files(file_paths)


def _to_audio_url(file_path: str) -> str:
    """
    将本地音频路径转换为接口 URL

    Args:
        file_path (str): 本地文件路径

    Returns:
        str: 可访问音频 URL
    """
    path = Path(file_path)
    # 判断是否在缓存还是在已合成目录下 生成对应 URL 路径
    parent_name = path.parent.name.lower()
    if parent_name == "output":
        return f"/audio/output/{path.name}"
    if parent_name == "cache":
        return f"/audio/cache/{path.name}"
    return f"/audio/{path.name}"


def _sanitize_segment(value: str) -> str:
    """
    清洗路径片段字符

    保留中文与常见可见字符 仅替换 Windows 非法字符

    Args:
        value (str): 原始路径片段

    Returns:
        str: 安全路径片段
    """
    segment = (value or "").strip()
    segment = re.sub(r'[<>:"/\\|?*\x00-\x1F]', "_", segment)
    segment = segment.rstrip(" .")
    if not segment:
        return ""
    # Windows 设备保留名避免冲突
    if segment.upper() in {
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    }:
        return f"{segment}_"
    return segment


def _extract_pdf_excerpt(file_bytes: bytes) -> str:
    """
    提取 PDF 文本预览
    """
    try:
        import fitz  # type: ignore
    except Exception:
        return ""

    doc = None
    try:
        doc = fitz.open(stream=file_bytes, filetype="pdf")
        chunks: List[str] = []
        total = 0
        for page in doc:
            text = (page.get_text("text") or "").strip()
            if not text:
                continue
            remain = ATTACHMENT_EXCERPT_LIMIT - total
            if remain <= 0:
                break
            if len(text) > remain:
                chunks.append(text[:remain])
                break
            chunks.append(text)
            total += len(text)
        return "\n\n".join(chunks).strip()
    except Exception:
        return ""
    finally:
        if doc is not None:
            doc.close()


def _extract_text_excerpt(file_bytes: bytes, filename: str, content_type: str) -> str:
    """
    提取文本附件预览内容

    Args:
        file_bytes (bytes): 文件原始字节
        filename (str): 文件名
        content_type (str): MIME 类型

    Returns:
        str: 文本预览内容 非文本返回空字符串
    """
    # 根据扩展名和 MIME 类型判断是否为文本文件 仅对文本文件进行预览提取
    ext = Path(filename or "").suffix.lower()
    if ext == ".pdf" or content_type == "application/pdf":
        return _extract_pdf_excerpt(file_bytes)

    is_text_like = ext in TEXT_EXTENSIONS or content_type.startswith("text/")
    if not is_text_like:
        return ""

    # 依次尝试常见编码读取文本
    for encoding in ("utf-8", "gb18030", "latin-1"):
        try:
            text = file_bytes.decode(encoding)
            text = text.strip()
            # 预览文本限制长度
            return text[:ATTACHMENT_EXCERPT_LIMIT]
        except Exception:
            continue
    return ""


def _extract_non_code_text(raw_text: str) -> tuple[str, str]:
    """
    去除完整代码块并返回可读文本

    返回值包含代码块外可见文本 与末尾未闭合代码片段缓存

    Args:
        raw_text (str): 原始文本

    Returns:
        tuple[str str]: 可见文本 与未闭合缓存
    """
    # 代码块为空时直接返回原文本与空缓存
    if not raw_text:
        return "", ""

    chunks: List[str] = []
    cursor = 0

    while True:
        # 查找代码块起始标记
        start = raw_text.find(FENCE_MARKER, cursor)
        # 未找到代码块时将剩余文本加入可见文本并返回
        if start < 0:
            chunks.append(raw_text[cursor:])
            return "".join(chunks), ""

        # 查找代码块结束标记
        end = raw_text.find(FENCE_MARKER, start + len(FENCE_MARKER))
        if end < 0:
            # 未闭合代码块放入 carry 由后续 token 继续补全
            chunks.append(raw_text[cursor:start])
            return "".join(chunks), raw_text[start:]

        chunks.append(raw_text[cursor:start])
        cursor = end + len(FENCE_MARKER)


def _normalize_tts_text(text: str) -> str:
    """
    规范化用于 TTS 的文本

    去除
    - 行内代码
    - 图片 markdown
    - 链接 markdown 仅保留可见文本
    - 标题 列表 引用标记
    - 常见加粗删除线标记
    - 归一化空白与空行

    Args:
        text (str): 原始文本

    Returns:
        str: 清洗后文本
    """
    if not text:
        return ""

    result = text
    # 兼容字面量换行转义 避免 "\n" 被当普通字符保留下来
    result = result.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\r", "\n")
    # 去除动作描述文本
    result = _strip_action_text(result)
    # 去除行内代码
    result = re.sub(r"`[^`\n]*`", " ", result)
    # 去除图片 markdown
    result = re.sub(r"!\[[^\]]*]\([^)]+\)", " ", result)
    # 链接 markdown 仅保留可见文本
    result = re.sub(r"\[([^\]]+)]\([^)]+\)", r"\1", result)
    # 去除标题 列表 引用标记
    result = re.sub(r"^\s*#{1,6}\s*", "", result, flags=re.MULTILINE)
    result = re.sub(r"^\s*[-*+]\s+", "", result, flags=re.MULTILINE)
    result = re.sub(r"^\s*\d+\.\s+", "", result, flags=re.MULTILINE)
    result = re.sub(r"^\s*>\s?", "", result, flags=re.MULTILINE)
    # 去除常见加粗删除线标记
    result = result.replace("**", "").replace("__", "").replace("~~", "")
    # 归一化空白与空行
    result = re.sub(r"[ \t]+", " ", result)
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result


def _strip_action_text(text: str) -> str:
    """
    去除常见动作标记文本

    支持格式
    - （动作）
    - (action)
    - *action*
    - **action**
    """
    if not text:
        return ""

    result = text
    # 多轮替换以处理相邻或嵌套的标记
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


def _has_speakable_content(text: str) -> bool:
    """
    判断文本是否包含可发音字符

    Args:
        text (str): 待检测文本

    Returns:
        bool: 是否可发音
    """
    return bool(re.search(r"[A-Za-z0-9\u4e00-\u9fff]", text or ""))


def _prepare_tts_text(full_text: str) -> str:
    """
    预处理整段回复文本用于 TTS

    先去除代码块内容 再执行 TTS 规范化 清洗掉 Markdown 语法链接表情等无意义文本 保留纯文本与可见文本

    Args:
        full_text (str): 原始完整回复

    Returns:
        str: 适合 TTS 的清洗文本
    """
    # 去除代码块后再执行 markdown 清洗
    plain_text, _ = _extract_non_code_text(full_text or "")
    return _normalize_tts_text(plain_text).strip()


class ChatRequest(BaseModel):
    """
    聊天请求模型

    - message (str): 用户消息
    - session_id (Optional[str]): 会话标识
    - mode (Optional[str]): 对话模式
    - attachments (Optional[List[Dict[str Any]]]): 附件列表
    """
    message: str
    session_id: Optional[str] = None
    mode: Optional[str] = "chat"
    attachments: Optional[List[Dict[str, Any]]] = None


class ChatResponse(BaseModel):
    """
    聊天响应模型

    - response (str): 回复文本
    - session_id (str): 会话标识
    - audio_url (Optional[str]): 音频地址
    - stopped (bool): 是否主动停止
    - intent (str): 意图类型
    """
    response: str
    session_id: str
    audio_url: Optional[str] = None
    stopped: bool = False
    intent: str = "chat"


@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """
    处理 HTTP 单次聊天请求

    Args:
        request (ChatRequest): 请求体对象

    Returns:
        ChatResponse: 回复结果对象
    """
    agent = get_agent()
    # 未传会话 id 时生成临时会话 id
    session_id = request.session_id or f"session_{uuid.uuid4().hex[:8]}"

    # 执行对话并获取回复结果
    result = await agent.run(
        user_input=request.message,
        session_id=session_id,
        mode=request.mode,
        attachments=request.attachments or [],
    )
    response_text = result.get("answer", "")

    # 根据回复文本生成 TTS 音频 仅对可发音文本执行生成 避免无效请求浪费资源
    audio_url = None
    if response_text:
        try:
            # 仅对可发音文本执行 TTS
            tts_text = _prepare_tts_text(response_text)
            if _has_speakable_content(tts_text):
                audio_file = await asyncio.get_event_loop().run_in_executor(None, lambda: generate_audio(tts_text))
                if audio_file:
                    audio_url = _to_audio_url(audio_file)
        except Exception as e:
            print(f"❌ [Chat HTTP] TTS error: {e}")

    return ChatResponse(
        response=response_text,
        session_id=session_id,
        audio_url=audio_url,
        stopped=bool(result.get("stopped", False)),
        intent=result.get("intent", "chat"),
    )


@router.post("/chat/upload")
async def upload_attachments(
    files: List[UploadFile] = File(...),
    session_id: Optional[str] = Form(None),
):
    """
    上传聊天附件文件

    Args:
        files (List[UploadFile]): 上传文件列表
        session_id (Optional[str]): 会话标识

    Returns:
        Dict[str Any]: 上传结果字典

    Raises:
        HTTPException: 当未上传文件时抛出 400
    """
    if not files:
        raise HTTPException(status_code=400, detail="没有上传文件")

    paths = get_paths()
    # 目录片段清洗 防止非法路径字符
    safe_session = _sanitize_segment(session_id or "temp") or "temp"
    upload_root = paths.data_dir / "uploads" / safe_session
    upload_root.mkdir(parents=True, exist_ok=True)

    uploaded: List[Dict[str, Any]] = []
    for upload in files:
        # 构造安全文件名并保留原始后缀
        original_name = upload.filename or "unnamed"
        suffix = Path(original_name).suffix
        safe_name = _sanitize_segment(Path(original_name).stem) or "file"
        saved_name = f"{safe_name}_{uuid.uuid4().hex[:8]}{suffix}"
        saved_path = upload_root / saved_name

        # 保存文件并提取文本预览
        raw = await upload.read()
        saved_path.write_bytes(raw)

        # 提取文本预览内容 仅对文本文件进行提取 非文本返回空字符串
        content_type = upload.content_type or "application/octet-stream"
        excerpt = _extract_text_excerpt(raw, original_name, content_type)
        relative_path = str(saved_path.relative_to(paths.root)).replace("\\", "/")
        url = f"/uploads/{quote(safe_session)}/{quote(saved_name)}"

        # 记录上传结果 包含原始文件名 安全文件名 存储路径 访问 URL 文件大小 MIME 类型 与文本预览
        uploaded.append(
            {
                "id": uuid.uuid4().hex[:12],
                "name": original_name,
                "saved_name": saved_name,
                "saved_path": relative_path,
                "url": url,
                "size": len(raw),
                "content_type": content_type,
                "text_excerpt": excerpt,
            }
        )

    return {"attachments": uploaded}


@router.websocket("/ws/chat")
async def websocket_chat(websocket: WebSocket):
    """
    处理 WebSocket 流式聊天请求

    调用流程
    1 接受连接并初始化运行状态
    2 循环接收前端消息并区分 ping stop message
    3 message 类型创建单任务 _process_one_message 串行执行
    4 _process_one_message 调用 agent.run_stream 获取增量 token
    5 on_token 将 token 推送前端 并切句后投递到音频队列
    6 audio_worker 消费句子队列生成分段音频并回传分段 URL
    7 本轮结束后合并分段音频并发送 done 事件
    8 连接断开或异常时触发停止事件并取消未完成任务

    Args:
        websocket (WebSocket): WebSocket 连接对象

    Returns:
        None
    """
    # 接受连接请求
    await websocket.accept()
    # 获取全局代理实例
    agent = get_agent()

    # 当前正在处理的请求任务与停止事件 用于实现串行处理与主动停止功能
    running_task: Optional[asyncio.Task] = None
    # 当前请求的停止事件 由 stop 消息触发
    running_stop_event: Optional[asyncio.Event] = None
    # 当前请求 id 用于 stopping 回包
    running_request_id: Optional[str] = None

    async def _process_one_message(payload: Dict[str, Any], stop_event: asyncio.Event):
        """
        处理单条 WebSocket 消息任务

        Args:
            payload (Dict[str Any]): 消息负载
            stop_event (asyncio.Event): 停止事件

        Returns:
            None
        """
        # 生成或提取请求 ID 用于响应关联 方便前端处理
        request_id = payload.get("request_id") or uuid.uuid4().hex[:8]
        # 提取用户消息文本
        user_message = payload.get("content", "")
        # 提取模式 chat narrative agent 三者中的一个
        mode = payload.get("mode", "chat")
        # 提取附件列表 缺省时为空数组
        attachments = payload.get("attachments") or []
        # 是否启用音频播报
        audio_enabled = bool(payload.get("audio_enabled", True))
        # 获取或创建会话 id
        session_id = payload.get("session_id") or f"session_{uuid.uuid4().hex[:8]}"

        # 消息内容与附件均为空时视为无效请求 直接返回错误提示
        if not user_message.strip() and not attachments:
            # 回传错误事件
            await websocket.send_json({"type": "error", "message": "Empty message", "request_id": request_id})
            # 结束本次处理
            return

        # 回传本次会话 id
        await websocket.send_json({"type": "session", "session_id": session_id, "request_id": request_id})

        # 音频分段队列与缓冲区 用于实现边生成边播功能
        audio_queue: asyncio.Queue[Optional[str]] = asyncio.Queue()
        # 存储分段音频路径 用于最终合并
        audio_chunks: List[str] = []
        # 文本切句缓冲区
        sentence_buffer = {"value": ""}
        # fenced 代码块缓冲区
        fenced_buffer = {"value": ""}

        async def audio_worker():
            """
            消费句子队列并生成分段音频

            Args:
                None

            Returns:
                None
            """
            # 当音频功能关闭时 直接退出该协程 避免不必要的资源占用
            if not audio_enabled:
                # 不进入队列消费逻辑
                return
            # 持续消费队列直到收到结束信号
            while True:
                # 从队列获取待生成句子 直到收到 None 或者停止事件被触发
                sentence = await audio_queue.get()
                # 结束哨兵到达则退出
                if sentence is None:
                    break
                # 在生成前检查停止事件 避免不必要的生成浪费资源
                if stop_event.is_set():
                    # 停止后退出循环
                    break

                try:
                    # 调用阻塞式生成函数放到线程池中执行 避免阻塞事件循环
                    audio_file = await asyncio.get_event_loop().run_in_executor(None, lambda: generate_audio(sentence))
                    # 生成成功时回传分段音频 URL
                    if audio_file:
                        # 保存分段路径用于最终合并
                        audio_chunks.append(audio_file)
                        # 推送 audio 事件到前端
                        await websocket.send_json(
                            {
                                "type": "audio",
                                "url": _to_audio_url(audio_file),
                                "request_id": request_id,
                            }
                        )
                # 生成失败时仅记录日志不中断会话
                except Exception as e:
                    logger.warning(f"[WS] TTS chunk failed: {e}")

        # 启动后台音频 worker
        worker_task = asyncio.create_task(audio_worker())

        async def on_token(token: str):
            """
            处理流式 token 回调

            提取可见文本切句并投递到音频队列

            Args:
                token (str): 本次增量文本

            Returns:
                None
            """
            # 若收到停止信号则忽略后续 token
            if stop_event.is_set():
                return
            # 先把 token 推送给前端显示
            await websocket.send_json({"type": "token", "content": token, "request_id": request_id})
            # 音频关闭时仅文本输出
            if not audio_enabled:
                return

            # 缓存 token 并剔除 fenced 代码内容
            fenced_buffer["value"] += token
            # 提取非代码区可见文本
            visible_text, carry = _extract_non_code_text(fenced_buffer["value"])
            # 保存未闭合代码块残留
            fenced_buffer["value"] = carry
            # 可见文本进入句子缓冲区并做 TTS 清洗
            if visible_text:
                sentence_buffer["value"] += visible_text

            # 持续尝试切出完整句子
            while True:
                # 按句号问号换行等边界切分句子
                match = SENTENCE_SPLIT_REGEX.search(sentence_buffer["value"])
                # 无完整句子时退出
                if not match:
                    break
                # 计算当前句子终点
                end = match.end()
                # 截取完整句子
                sentence = sentence_buffer["value"][:end].strip()
                # 保留剩余未完成句子
                sentence_buffer["value"] = sentence_buffer["value"][end:]
                # 句级清洗 避免动作标记跨 token 时漏过滤
                sentence = _normalize_tts_text(sentence).strip()
                # 仅投递可发音句子
                if sentence and _has_speakable_content(sentence):
                    # 将可发音句子投递到音频队列
                    await audio_queue.put(sentence)

        try:
            # 启动流式推理
            result = await agent.run_stream(
                user_input=user_message,
                session_id=session_id,
                mode=mode,
                attachments=attachments,
                on_token=on_token,
                should_stop=stop_event.is_set,
            )

            # 音频开启时处理尾部剩余文本并等待 worker 收尾
            if audio_enabled:
                # 处理缓冲区尾部文本
                visible_text, _ = _extract_non_code_text(fenced_buffer["value"])
                # 尾部文本追加到句子缓冲区
                if visible_text:
                    sentence_buffer["value"] += visible_text
                # 提取最终尾句
                tail = _normalize_tts_text(sentence_buffer["value"]).strip()
                # 尾句可发音则投递
                if tail and _has_speakable_content(tail):
                    await audio_queue.put(tail)
                # 发送结束哨兵并等待音频任务退出
                await audio_queue.put(None)
                await worker_task

            # 预设完整音频 URL
            full_audio_url = None
            # 有分段音频时执行合并
            if audio_enabled and audio_chunks:
                # 合并本次回复全部音频分段
                merged_file = await asyncio.get_event_loop().run_in_executor(
                    None, lambda: merge_audio_chunks(audio_chunks)
                )
                # 合并成功时转换 URL
                if merged_file:
                    full_audio_url = _to_audio_url(merged_file)

            # 推送 done 事件
            await websocket.send_json(
                {
                    "type": "done",
                    "request_id": request_id,
                    "stopped": bool(result.get("stopped", False)),
                    "full_audio_url": full_audio_url,
                    "intent": result.get("intent", "chat"),
                }
            )
        # 处理本次消息异常
        except Exception as e:
            # worker 未结束则取消
            if not worker_task.done():
                # 出错时取消音频任务
                worker_task.cancel()
            # 回传错误事件
            await websocket.send_json({"type": "error", "message": str(e), "request_id": request_id})

    try:
        # 连接生命周期循环
        while True:
            # 接收客户端 JSON 消息
            data = await websocket.receive_json()
            # 读取消息类型
            msg_type = data.get("type")

            # ping 保活消息
            if msg_type == "ping":
                # 保活响应
                await websocket.send_json({"type": "pong"})
                continue

            # 若旧任务已完成则回收状态
            if running_task and running_task.done():
                try:
                    # 触发异常抛出以便记录
                    running_task.result()
                except Exception as e:
                    print(f"❌ [WS] previous task error: {e}")
                # 清理运行状态
                running_task = None
                running_stop_event = None
                running_request_id = None

            # stop 类型用于中断当前任务
            if msg_type == "stop":
                if running_stop_event and running_task and not running_task.done():
                    # 设置停止标记 通知当前任务结束
                    running_stop_event.set()
                    # 回传 stopping 事件
                    await websocket.send_json(
                        {
                            "type": "stopping",
                            "request_id": running_request_id,
                        }
                    )
                continue

            # 非 message 类型直接忽略
            if msg_type != "message":
                continue

            # 串行保护 当前有任务时拒绝新任务
            if running_task and not running_task.done():
                # 串行处理请求 防止多请求并发冲突
                await websocket.send_json(
                    {
                        "type": "error",
                        "message": "Previous request still running",
                        "request_id": data.get("request_id"),
                    }
                )
                continue

            # 生成本次请求 id
            running_request_id = data.get("request_id") or uuid.uuid4().hex[:8]
            # 创建停止事件
            running_stop_event = asyncio.Event()
            # 复制消息负载并写入 request_id
            payload = dict(data)
            payload["request_id"] = running_request_id
            # 启动新任务处理本条消息
            running_task = asyncio.create_task(_process_one_message(payload, running_stop_event))

    # 客户端主动断开连接
    except WebSocketDisconnect:
        # 若有运行中任务则尝试停止
        if running_task and not running_task.done():
            # 设置停止标记
            if running_stop_event:
                running_stop_event.set()
            # 取消协程任务
            running_task.cancel()
        # 记录断开日志
        logger.error("WebSocket 取消连接")
    # 连接循环其他异常
    except Exception as e:
        # 若有运行中任务则尝试停止
        if running_task and not running_task.done():
            # 设置停止标记
            if running_stop_event:
                running_stop_event.set()
            # 取消协程任务
            running_task.cancel()
        # 记录错误日志
        logger.error(f"WebSocket error: {e}")
