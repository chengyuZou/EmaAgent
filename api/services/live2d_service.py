"""
Live2D 控制服务模块

该模块负责表情状态 情绪映射 口型同步与状态查询
"""

from typing import Dict, List, Optional
from dataclasses import dataclass, field
from enum import Enum
import asyncio

from utils.logger import logger

class EmaExpression(Enum):
    """
    艾玛表情枚举
    """
    NORMAL = "normal"
    TAISHOU = "taishou"
    LIULEI = "liulei"
    MONVHUA = "monvhua"


class EmaEmotion(Enum):
    """
    艾玛情绪枚举

    Examples:
        >>> EmaEmotion.HAPPY.value
        'happy'
    """
    HAPPY = "happy"
    SAD = "sad"
    ANGRY = "angry"
    SURPRISED = "surprised"
    NORMAL = "normal"
    SHY = "shy"


@dataclass
class Live2DState:
    """
    Live2D 状态数据模型

    该模型保存前端模型参数与当前播放状态(但似乎没有用?)

    - mouth_open (float): 嘴巴张开值 0-1
    - mouth_form (float): 嘴型参数 -1-1
    - eye_l_open (float): 左眼开合值 0-1
    - eye_r_open (float): 右眼开合值 0-1
    - eye_l_smile (float): 左眼微笑值 0-1
    - eye_r_smile (float): 右眼微笑值 0-1
    - eye_ball_x (float): 眼球横向偏移 -1-1
    - eye_ball_y (float): 眼球纵向偏移 -1-1
    - brow_l_y (float): 左眉参数 -1-1
    - brow_r_y (float): 右眉参数 -1-1
    - body_angle_x (float): 身体横向角度 -30-30
    - body_angle_y (float): 身体纵向角度 -30-30
    - body_angle_z (float): 身体旋转角度 -30-30
    - angle_x (float): 头部输入 x -30-30
    - angle_y (float): 头部输入 y -30-30
    - angle_z (float): 头部输入 z -30-30
    - current_expression (str): 当前表情 normal taishou liulei monvhua
    - is_speaking (bool): 当前是否说话
    """
    mouth_open: float = 0.0
    mouth_form: float = 0.0
    eye_l_open: float = 1.0
    eye_r_open: float = 1.0
    eye_l_smile: float = 0.0
    eye_r_smile: float = 0.0
    eye_ball_x: float = 0.0
    eye_ball_y: float = 0.0
    brow_l_y: float = 0.0
    brow_r_y: float = 0.0

    body_angle_x: float = 0.0
    body_angle_y: float = 0.0
    body_angle_z: float = 0.0

    angle_x: float = 0.0
    angle_y: float = 0.0
    angle_z: float = 0.0

    current_expression: str = "normal"
    is_speaking: bool = False

    def to_dict(self) -> Dict:
        """
        转换为前端参数字典

        Args:
            None:

        Returns:
            Dict: 可直接下发给前端的状态字典
        """
        return {
            "parameters": {
                "ParamMouthOpenY": self.mouth_open,
                "ParamMouthForm": self.mouth_form,
                "ParamEyeLOpen": self.eye_l_open,
                "ParamEyeROpen": self.eye_r_open,
                "ParamEyeLSmile": self.eye_l_smile,
                "ParamEyeRSmile": self.eye_r_smile,
                "ParamEyeBallX": self.eye_ball_x,
                "ParamEyeBallY": self.eye_ball_y,
                "ParamBrowLY": self.brow_l_y,
                "ParamBrowRY": self.brow_r_y,
                "Param85": self.angle_x,
                "Param86": self.angle_y,
                "Param87": self.angle_z,
            },
            "expression": self.current_expression,
            "is_speaking": self.is_speaking
        }


class Live2DService:
    """
    Live2D 控制服务

    该类负责情绪到参数映射 表情设置 口型序列生成与状态重置
    """

    EMOTION_EXPRESSION_MAP = {
        EmaEmotion.HAPPY: {
            "eye_l_smile": 0.8,
            "eye_r_smile": 0.8,
            "mouth_form": 0.5,
        },
        EmaEmotion.SAD: {
            "expression": "liulei",
            "brow_l_y": -0.5,
            "brow_r_y": -0.5,
            "mouth_form": -0.5,
        },
        EmaEmotion.ANGRY: {
            "brow_l_y": -1.0,
            "brow_r_y": -1.0,
            "mouth_form": -1.0,
        },
        EmaEmotion.SURPRISED: {
            "eye_l_open": 1.9,
            "eye_r_open": 1.9,
            "brow_l_y": 1.0,
            "brow_r_y": 1.0,
            "mouth_open": 0.8,
        },
        EmaEmotion.SHY: {
            "eye_l_smile": 0.5,
            "eye_r_smile": 0.5,
            "mouth_form": 0.3,
        },
        EmaEmotion.NORMAL: {}
    }

    def __init__(self):
        """
        初始化 Live2D 服务状态
        """
        # 初始化状态对象和口型同步控制变量
        self.state = Live2DState()
        self._lip_sync_task: Optional[asyncio.Task] = None
        # 口型同步锁确保同一时间只有一个口型生成任务在运行
        self._speaking_lock = asyncio.Lock()

    def set_expression(self, expression: str) -> None:
        """
        设置当前表情

        Args:
            expression (str): 表情名称 normal taishou liulei monvhua

        Returns:
            None
        """
        self.state.current_expression = expression
        logger.info(f"设置表情为: {expression}")
        return self.state.to_dict()

    def set_emotion(self, emotion: EmaEmotion) -> Dict:
        """
        根据情绪更新参数

        Args:
            emotion (EmaEmotion): 目标情绪

        Returns:
            Dict: 当前状态字典
        """
        params: dict = self.EMOTION_EXPRESSION_MAP.get(emotion, {})
        for key, value in params.items():
            setattr(self.state, key, value)

    def set_mouth_open(self, value: float) -> Dict:
        """
        设置口型开合值

        Args:
            value (float): 输入范围建议 0 到 1

        Returns:
            Dict: 当前状态字典
        """
        self.state.mouth_open = value * 2.1
        self.state.is_speaking = value > 0.1
        return self.state.to_dict()

    async def generate_lip_sync_sequence(
        self,
        duration_ms: int,
        callback: callable
    ):
        """
        按时长生成口型序列

        该方法会以约 20 FPS 生成口型并通过回调下发状态

        Args:
            duration_ms (int): 音频时长 毫秒
            callback (callable): 每帧异步回调函数

        Returns:
            None

        Raises:
            Exception: 回调内部异常由上层处理
        """
        import math
        import random

        async with self._speaking_lock:
            self.state.is_speaking = True

            frame_interval = 0.05
            total_frames = int(duration_ms / 1000 / frame_interval)

            for i in range(total_frames):
                t = i / total_frames
                base_wave = math.sin(i * 0.3) * 0.5 + 0.5
                noise = random.uniform(-0.1, 0.1)
                mouth_value = max(0, min(1, base_wave + noise))

                if random.random() < 0.1:
                    mouth_value *= 0.2

                self.set_mouth_open(mouth_value)
                await callback(self.state.to_dict())
                await asyncio.sleep(frame_interval)

            self.set_mouth_open(0)
            self.state.is_speaking = False
            await callback(self.state.to_dict())

    def reset(self):
        """
        重置到默认状态

        Args:
            None

        Returns:
            Dict: 默认状态字典
        """
        self.state = Live2DState()
        return self.state.to_dict()

    def get_state(self) -> Dict:
        """
        获取当前状态快照

        Args:
            None

        Returns:
            Dict: 当前状态字典
        """
        return self.state.to_dict()


_live2d_service: Optional[Live2DService] = None


def get_live2d_service() -> Live2DService:
    """
    获取 Live2D 服务单例

    Args:
        None

    Returns:
        Live2DService: 全局单例对象
    """
    global _live2d_service
    if _live2d_service is None:
        _live2d_service = Live2DService()
    return _live2d_service
