from typing import List

from pydantic import BaseModel


class AudioInfo(BaseModel):
    """音频文件信息"""

    filename: str
    url: str
    size: int


class AudioListResponse(BaseModel):
    """音频列表响应体"""

    files: List[AudioInfo]


class ClearAudioCacheResponse(BaseModel):
    """清理缓存响应体"""

    status: str
