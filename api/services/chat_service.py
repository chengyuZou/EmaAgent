import asyncio
import re
import uuid
from pathlib import Path
from typing import Optional, List, Dict, Any
from urllib.parse import quote

from fastapi import WebSocket, WebSocketDisconnect, HTTPException, UploadFile

from config.paths import get_paths
from audio.base import normalize_tts_text, has_speakable_content
from api.services.tts_service import get_tts_service

from agent.EmaAgent import get_agent
from utils.logger import logger

# 分离文本的句子边界正则 支持中文句号问号感叹号换行等
SENTENCE_SPLIT_REGEX = re.compile(r"[。！？?!\n]")
# 支持的文件文本预览扩展名
TEXT_EXTENSIONS = {".txt", ".md", ".py", ".json", ".yaml", ".yml", ".csv", ".log", ".ini"}
ATTACHMENT_EXCERPT_LIMIT = 12000
# 代码块标记 用于分离可见文本与代码内容 避免 TTS 朗读代码
FENCE_MARKER = "```"


class ChatService:

    def _to_audio_url(self, file_path: str) -> str:
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
    
    def _sanitize_segment(self, value: str) -> str:
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
    
    def _extract_pdf_excerpt(self, file_bytes: bytes) -> str:
        """
        从 PDF 文件字节中提取文本摘要

        Args:
            file_bytes (bytes): PDF 文件内容的字节数据

        Returns:
            str: 提取的文本摘要
        """
        try:
            import fitz  # PyMuPDF
        except ImportError:
            return "无法提取 PDF 内容，请安装 PyMuPDF 库（pip install PyMuPDF）"
        
        doc = None
        try:
            # 打开 PDF 文档 从字节流中读取
            doc = fitz.open(stream=file_bytes, filetype="pdf")

            # 提取前几页的文本内容 直到达到字数限制
            chunks: List[str] = []
            total = 0
            for page in doc:
                text = (page.get_text("text") or "").strip()
                if not text:
                    continue

                # 剩余可用字数
                remain = ATTACHMENT_EXCERPT_LIMIT - total
                if remain <= 0:
                    break

                # 如果当前页文本超过剩余字数 则截断后添加并结束循环
                if len(text) > remain:
                    text = text[:remain]
                    chunks.append(text)
                    break

                # 添加当前页文本并更新总字数
                chunks.append(text)
                total += len(text)

            return "\n\n".join(chunks).strip()
        except Exception as e:
            return f"提取 PDF 内容失败: {str(e)}"
        finally:
            if doc is not None:
                doc.close()
    
    def _extract_text_excerpt(self, file_bytes: bytes, filename: str, content_type: str) -> str:
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
            return self._extract_pdf_excerpt(file_bytes)

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

    def _extract_non_code_text(self, raw_text: str) -> tuple[str, str]:
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

        # 将文本按代码块分割 成偶数索引的部分为可见文本 奇数索引的部分为代码内容
        while True:
            # 查找代码块 start 位置
            start = raw_text.find(FENCE_MARKER, cursor)
            # 若未找到 则剩余文本全部为可见文本 追加后退出循环
            if start < 0:
                chunks.append(raw_text[cursor:])
                return "".join(chunks), ""
            
            # 查找代码块 end 位置 从 start 之后开始查找
            end = raw_text.find(FENCE_MARKER, start + len(FENCE_MARKER))
            # 若未找到 则说明代码块未闭合 将剩余文本追加到可见文本后并将未闭合部分返回到缓存
            if end < 0:
                # 未闭合代码块放入 carry 由后续 token 继续补全
                chunks.append(raw_text[cursor:start])
                return "".join(chunks), raw_text[start:]

            # 添加可见文本部分
            chunks.append(raw_text[cursor:start])
            # 跳过代码块内容
            cursor = end + len(FENCE_MARKER)

    async def upload_attachment(
        self,
        files: List[UploadFile],
        session_id: Optional[str] = None
    ) -> Dict[str, Any]:
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
            raise HTTPException(status_code=400, detail="未上传文件")
        
        # 获取路径
        paths = get_paths()
        # 目录片段清洗 防止非法路径字符
        safe_session_id = self._sanitize_segment(session_id or "temp") or "temp"
        # 构建安全的文件保存路径 避免目录穿越等安全风险
        upload_root = paths.uploads_dir / safe_session_id
        upload_root.mkdir(parents=True, exist_ok=True)

        uploaded: List[Dict[str, Any]] = []
        for file in files:
            # 构造安全文件名并保留原始后缀
            original_name = file.filename or "unnamed"
            suffix = Path(original_name).suffix
            safe_name = self._sanitize_segment(Path(original_name).stem) or "file"
            saved_name = f"{safe_name}_{uuid.uuid4().hex[:8]}{suffix}"
            saved_path = upload_root / saved_name

            # 保存文件并提取文本预览
            raw = await file.read()
            saved_path.write_bytes(raw)

            # 提取文本预览内容 仅对文本文件进行提取 非文本返回空字符串
            content_type = file.content_type or "application/octet-stream"
            excerpt = self._extract_text_excerpt(raw, original_name, content_type)
            relative_path = str(saved_path.relative_to(paths.root)).replace("\\", "/")
            url = f"/uploads/{quote(safe_session_id)}/{quote(saved_name)}"

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



    async def websocket_chat(self, websocket: WebSocket):
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
        _ema_agent = get_agent()

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
                    - request_id (str): 请求 ID 用于标识与停止
                    - user_message (str): 用户输入消息
                    - mode (str): 运行模式 chat narrative agent
                    - attachments (List[Dict]): 附件列表
                    - audio_enabled (bool): 是否启用音频合成功能
                    - session_id (str): 会话 ID 用于上下文关联

                stop_event (asyncio.Event): 停止事件

            Returns:
                None
            """

            # 先获取 payload 中的必要字段 进行基本校验
            request_id = payload.get("request_id") or uuid.uuid4().hex[:8]
            user_message: str = payload.get("content", "")
            mode = payload.get("mode", "chat")
            attachments = payload.get("attachments", [])
            audio_enabled = bool(payload.get("audio_enabled", True))
            session_id = payload.get("session_id") or f"session_{uuid.uuid4().hex[:8]}"

            # 若消息内容与附件为空 则直接返回错误提示
            if not user_message.strip() and not attachments:
                await websocket.send_json({
                    "type": "error",
                    "request_id": request_id,
                    "message": "消息内容与附件不能同时为空"
                })
                return
            
            # 音频分段队列与缓冲区 用于实现边生成边播功能
            audio_queue: asyncio.Queue[Optional[str]] = asyncio.Queue()
            # 存储分段音频路径 用于最后合并
            audio_chunks: List[str] = []
            # 当前文本缓冲区 用于增量切句
            sentence_buffer = {"value": ""}
            # fenced 代码块状态 用于避免切句时将代码内容误认为可读文本
            fenced_buffer = {"value": ""}

            async def audio_worker():
                """ 消息处理过程中独立的音频生成与发送任务 """
                # 当音频功能关闭时 直接退出该协程 避免不必要的资源占用
                if not audio_enabled:
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
                        break

                    try:
                        # 调用阻塞式生成函数放到线程池中执行 避免阻塞事件循环
                        audio_file = await asyncio.get_event_loop().run_in_executor(
                            None, lambda: get_tts_service().generate(sentence)
                        )
                        # 生成成功时回传分段音频 URL
                        if audio_file:
                            # 保存分段路径用于最终合并
                            audio_chunks.append(audio_file)
                            # 推送 audio 事件到前端
                            await websocket.send_json({
                                "type": "audio",
                                "url": self._to_audio_url(audio_file),
                                "request_id": request_id,
                            })
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
                await websocket.send_json({
                    "type": "token",
                    "content": token,
                    "request_id": request_id,
                })
                # 音频关闭时仅文本输出
                if not audio_enabled:
                    return
                
                # 缓存 token 并剔除 fenced 代码内容
                fenced_buffer["value"] += token
                # 提取非代码区可见文本
                visible_text, carry = self._extract_non_code_text(fenced_buffer["value"])
                # 保存未闭合代码块残留
                fenced_buffer["value"] = carry
                # 将可见文本追加到切句缓冲区
                sentence_buffer["value"] += visible_text

                # 持续尝试切出完整句子
                while True:
                    # 按句号问号换行等边界切分句子
                    match = SENTENCE_SPLIT_REGEX.search(sentence_buffer["value"])
                    # 无完整句子退出
                    if not match:
                        break
                    # 计算当前句子重点
                    end = match.end()
                    # 截取完整句子
                    sentence = sentence_buffer["value"][:end].strip()
                    # 更新缓冲区剩余部分
                    sentence_buffer["value"] = sentence_buffer["value"][end:]
                    # 规范化句子文本 例如去除多余空白与动作描述等 以提升 TTS 朗读质量
                    sentence = normalize_tts_text(sentence)
                    # 仅投递可发音句子
                    if sentence and has_speakable_content(sentence):
                        await audio_queue.put(sentence)
        
            try:
                # 启动流式推理
                result = await _ema_agent.run_stream(
                    user_input=user_message,
                    session_id=session_id,
                    mode=mode,
                    attachments=attachments,
                    on_token=on_token,
                    should_stop=stop_event.is_set,
                )

                # 音频开启时处理尾部剩余文本并等待 worker 收尾
                if audio_enabled:
                    # 处理缓冲区尾部文本 例如用户输入未以完整句子结尾的情况
                    visible_text, _ = self._extract_non_code_text(fenced_buffer["value"])
                    # 尾部文本追加到句子缓冲区
                    if visible_text:
                        sentence_buffer["value"] += visible_text
                    # 提取最终尾句并投递到音频队列
                    final_sentence = sentence_buffer["value"].strip()
                    final_sentence = normalize_tts_text(final_sentence)
                    # 如果尾句可发音则投递
                    if final_sentence and has_speakable_content(final_sentence):
                        await audio_queue.put(final_sentence)

                    # 发送结束哨兵并等待 worker 处理完毕
                    await audio_queue.put(None)
                    await worker_task

                # 预设完整音频 URL
                full_audio_url = None
                # 有分段音频时执行合并
                if audio_enabled and audio_chunks:
                    # 合并本次回复全部音频分段
                    merged_file = await asyncio.get_event_loop().run_in_executor(
                        None, lambda: get_tts_service().merge_audio_files(audio_chunks)
                    )

                    # 生成完整音频 URL
                    if merged_file:
                        full_audio_url = self._to_audio_url(merged_file)
                    
                    # 推动完整音频 URL 到前端
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
                await websocket.send_json({
                    "type": "error", 
                    "message": str(e), 
                    "request_id": request_id
                })
        
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
                        logger.warning(f"[WS] Previous task ended with exception: {e}")

                    # 清理运行状态
                    running_task = None
                    running_stop_event = None
                    running_request_id = None

                # stop 消息触发停止事件
                if msg_type == "stop":
                    if running_stop_event and running_task and not running_task.done():
                        running_stop_event.set()
                        # 设置停止标记 通知当前任务结束
                        running_stop_event.set()
                        # 回传 stopping 事件
                        await websocket.send_json({
                            "type": "stopping",
                            "request_id": running_request_id,
                        })
                    continue

                # 非 message 类型直接忽略
                if msg_type != "message":
                    continue

                # 串行保护 当前有任务时拒绝新任务
                if running_task and not running_task.done():
                    await websocket.send_json({
                        "type": "error",
                        "message": "当前有请求正在处理，请稍后再试",
                        "request_id": data.get("request_id"),
                    })
                    continue

                # 生成本次请求 id
                running_request_id = data.get("request_id") or uuid.uuid4().hex[:8]
                # 创建新的停止事件
                running_stop_event = asyncio.Event()
                # 复制消息负载并写入 request_id
                payload = dict(data)
                payload["request_id"] = running_request_id
                # 创建并启动处理任务
                running_task = asyncio.create_task(_process_one_message(payload, running_stop_event))
        # 客户端主动断开连接
        except WebSocketDisconnect:
            # 若有运行中任务则尝试停止
            if running_task and not running_task.done():
                # 设置停止标记
                if running_stop_event:
                    running_stop_event.set()
                # 取消未完成任务
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
                # 取消未完成任务
                running_task.cancel()
            # 记录异常日志
            logger.error(f"WebSocket 连接异常: {e}")

    async def chat(
        self,
        message: str,
        session_id: Optional[str] = None,
        mode: str = "chat",
        attachments: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """
        处理 HTTP 聊天请求

        Args:
            request (ChatRequest): 聊天请求对象

        Returns:
            ChatResponse: 聊天响应对象
        """
        # 获取全局代理实例
        agent = get_agent()

        # 未传会话 id 时生成临时会话 id
        session_id = session_id or f"session_{uuid.uuid4().hex[:8]}"

        # 处理聊天请求 目前仅支持非流式接口 后续可根据需求添加流式版本
        result = await agent.run(
            user_input=message,
            session_id=session_id,
            mode=mode,
            attachments=attachments or [],
        )
        response_text = result.get("answer", "")

        # 根据回复文本生成 TTS 音频 仅对可发音文本执行生成 避免无效请求浪费资源
        audio_url = None
        if response_text:
            try:
                # 规范化文本以提升 TTS 质量
                plain_text, _ = self._extract_non_code_text(response_text)
                normalized_text = normalize_tts_text(plain_text)
                if has_speakable_content(normalized_text):
                    audio_file = await asyncio.get_event_loop().run_in_executor(
                        None, lambda: get_tts_service().generate(normalized_text)
                    )
                    if audio_file:
                        audio_url = self._to_audio_url(audio_file)
            except Exception as e:
                logger.warning(f"TTS generation failed: {e}")
                
        return {
            "response": response_text,
            "session_id": session_id,
            "audio_url": audio_url,
            "stopped": bool(result.get("stopped", False)),
            "intent": result.get("intent", "chat"),
        }


_chat_service: Optional[ChatService] = None


def get_chat_service() -> ChatService:
    """
    获取全局 ChatService 实例
    """
    global _chat_service
    if _chat_service is None:
        _chat_service = ChatService()
    return _chat_service