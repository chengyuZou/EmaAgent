"""
Session routes.
"""

from fastapi import APIRouter, HTTPException

from api.routes.schemas.sessions import (
    MessageInfo,
    MessagesResponse,
    NewSessionRequest,
    RenameRequest,
    SessionInfo,
    SessionListResponse,
)
from api.services.session_service import get_session_service

router = APIRouter()


@router.get("/sessions", response_model=SessionListResponse)
async def list_sessions():
    """
    获取会话列表
    """
    service = get_session_service()
    sessions_data = service.list_sessions()

    sessions = [
        SessionInfo(
            id=s["id"],
            created_at=s["created_at"],
            updated_at=s["updated_at"],
            last_message_at=s["updated_at"],
            message_count=s["message_count"],
        )
        for s in sessions_data
    ]
    return SessionListResponse(sessions=sessions)


@router.post("/sessions/new")
async def create_new_session(request: NewSessionRequest):
    """
    创建新会话
    """
    service = get_session_service()
    session = service.create_new_session(request.session_id)
    return {
        "status": "created",
        "session_id": session.session_id,
        "title": session.session_id,
    }


@router.get("/sessions/{session_id}/messages", response_model=MessagesResponse)
async def get_session_messages(session_id: str):
    """
    获取指定会话消息
    """
    service = get_session_service()
    messages_data = service.get_session_messages(session_id)
    messages = [
        MessageInfo(role=m["role"], content=m["content"], timestamp=m["timestamp"])
        for m in messages_data
    ]
    return MessagesResponse(messages=messages)


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    """
    删除指定会话
    """
    service = get_session_service()
    if service.delete_session(session_id):
        return {"status": "deleted", "session_id": session_id}
    raise HTTPException(status_code=404, detail="Session not found")


@router.post("/sessions/{session_id}/rename")
async def rename_session(session_id: str, request: RenameRequest):
    """
    重命名会话
    """
    service = get_session_service()
    if service.rename_session(session_id, request.new_name):
        return {"status": "renamed", "session_id": session_id, "new_id": request.new_name}
    raise HTTPException(status_code=404, detail="Session not found or name conflict")
