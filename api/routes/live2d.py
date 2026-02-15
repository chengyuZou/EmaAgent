"""
Live2D 路由模块

该模块提供状态查询 表情控制 情感控制 重置 与 WebSocket 实时控制接口
"""

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from typing import Optional
import asyncio

from api.services.live2d_service import (
    get_live2d_service,
    EmaEmotion,
    EmaExpression
)
from utils.logger import logger


router = APIRouter(prefix="/live2d", tags=["Live2D"])


@router.get("/state")
async def get_live2d_state():
    """
    获取当前 Live2D 状态

    Args:
        None

    Returns:
        Dict[str Any]: 状态响应字典
    """
    # 读取服务层当前状态快照
    service = get_live2d_service()
    return {
        "status": "success",
        "data": service.get_state()
    }


@router.post("/expression/{expression}")
async def set_expression(expression: str):
    """
    设置 Live2D 表情

    Args:
        expression (str): 表情名称 normal taishou liulei monvhua

    Returns:
        Dict[str Any]: 设置后状态响应字典
    """
    # 调用服务层更新当前表情
    service = get_live2d_service()
    state = service.set_expression(expression)
    return {
        "status": "success",
        "data": state
    }


@router.post("/emotion/{emotion}")
async def set_emotion(emotion: str):
    """
    设置 Live2D 情感状态

    Args:
        emotion (str): 情感名称 happy sad angry surprised normal shy

    Returns:
        Dict[str Any]: 设置结果响应字典
    """
    try:
        # 将字符串转为枚举类型
        ema_emotion = EmaEmotion(emotion)
    except ValueError:
        # 情感值非法时返回错误响应
        return {
            "status": "error",
            "message": f"Unknown emotion: {emotion}"
        }

    # 调用服务层应用情感状态
    service = get_live2d_service()
    state = service.set_emotion(ema_emotion)
    return {
        "status": "success",
        "data": state
    }


@router.post("/reset")
async def reset_live2d():
    """
    重置 Live2D 状态

    Args:
        None

    Returns:
        Dict[str Any]: 重置后状态响应字典
    """
    # 重置到默认表情与默认情绪
    service = get_live2d_service()
    state = service.reset()
    return {
        "status": "success",
        "data": state
    }


@router.websocket("/ws")
async def live2d_websocket(websocket: WebSocket):
    """
    处理 Live2D WebSocket 连接

    该接口用于接收前端控制指令 并实时回传状态

    Args:
        websocket (WebSocket): WebSocket 连接对象

    Returns:
        None
    """
    # 接受连接并记录日志
    await websocket.accept()
    logger.info("Live2D WebSocket 已连接")

    # 获取 Live2D 服务实例
    service = get_live2d_service()

    try:
        # 连接建立后先发送初始状态
        await websocket.send_json({
            "type": "state",
            "data": service.get_state()
        })

        while True:
            # 接收前端发送的控制命令
            data = await websocket.receive_json()
            cmd = data.get("command")

            if cmd == "set_expression":
                # 更新表情后回传最新状态
                expression = data.get("expression", "normal")
                state = service.set_expression(expression)
                await websocket.send_json({
                    "type": "state",
                    "data": state
                })

            elif cmd == "set_emotion":
                try:
                    # 更新情绪后回传最新状态
                    emotion = EmaEmotion(data.get("emotion", "normal"))
                    state = service.set_emotion(emotion)
                    await websocket.send_json({
                        "type": "state",
                        "data": state
                    })
                except ValueError:
                    # 非法情绪值返回错误消息
                    await websocket.send_json({
                        "type": "error",
                        "message": "Unknown emotion"
                    })

            elif cmd == "set_mouth":
                # 设置嘴型开合值并回传状态
                value = float(data.get("value", 0))
                state = service.set_mouth_open(value)
                await websocket.send_json({
                    "type": "state",
                    "data": state
                })

            elif cmd == "get_state":
                # 按需返回当前状态
                await websocket.send_json({
                    "type": "state",
                    "data": service.get_state()
                })

    except WebSocketDisconnect:
        # 客户端断开连接时记录日志
        logger.info("Live2D WebSocket 已断开")
    except Exception as e:
        # 其他异常统一记录错误日志
        logger.error(f"Live2D WebSocket 错误: {e}")
