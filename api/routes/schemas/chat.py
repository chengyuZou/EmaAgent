from typing import Any, Dict, List, Optional

from pydantic import BaseModel


class ChatRequest(BaseModel):
    """HTTP 聊天请求体"""

    message: str
    session_id: Optional[str] = None
    mode: Optional[str] = "chat"
    attachments: Optional[List[Dict[str, Any]]] = None


class ChatResponse(BaseModel):
    """HTTP 聊天响应体"""

    response: str
    session_id: str
    audio_url: Optional[str] = None
    stopped: bool = False
    intent: str = "chat"


class AttachmentUploadItem(BaseModel):
    """单个上传附件信息"""

    id: str
    name: str
    saved_name: str
    saved_path: str
    url: str
    size: int
    content_type: str
    text_excerpt: str = ""


class UploadAttachmentResponse(BaseModel):
    """上传附件响应体"""

    attachments: List[AttachmentUploadItem]
