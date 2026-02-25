"""聊天路由层，只做 HTTP/WebSocket 适配。"""

from typing import List, Optional

from fastapi import APIRouter, File, Form, UploadFile, WebSocket

from api.routes.schemas.chat import ChatRequest, ChatResponse, UploadAttachmentResponse
from api.services.chat_service import get_chat_service

router = APIRouter()
chat_service = get_chat_service()


@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    result = await chat_service.chat(
        message=request.message,
        session_id=request.session_id,
        mode=request.mode or "chat",
        attachments=request.attachments or [],
    )
    return ChatResponse(**result)


@router.post("/chat/upload", response_model=UploadAttachmentResponse)
async def upload_attachments(
    files: List[UploadFile] = File(...),
    session_id: Optional[str] = Form(None),
) -> UploadAttachmentResponse:
    result = await chat_service.upload_attachment(files=files, session_id=session_id)
    return UploadAttachmentResponse(**result)


@router.websocket("/ws/chat")
async def websocket_chat(websocket: WebSocket):
    await chat_service.websocket_chat(websocket)
