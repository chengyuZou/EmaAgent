from typing import List, Optional

from pydantic import BaseModel


class TrackInfo(BaseModel):
    """
    单曲信息模型

    - id (str): 单曲标识
    - title (str): 标题
    - artist (str): 艺术家
    - url (str): 文件访问地址
    - duration (float): 时长秒数
    - play_count (int): 播放次数
    - last_played (Optional[str]): 最近播放时间
    - is_favorited (bool): 是否收藏
    - cover_art (Optional[str]): 封面地址
    """

    id: str
    title: str
    artist: str
    url: str
    duration: float = 0
    play_count: int = 0
    last_played: Optional[str] = None
    is_favorited: bool = False
    cover_art: Optional[str] = None


class PlaylistResponse(BaseModel):
    """
    播放列表响应模型

    - tracks (List[TrackInfo]): 单曲列表
    - total (int): 总数量
    """

    tracks: List[TrackInfo]
    total: int


class RenameRequest(BaseModel):
    """
    重命名请求模型

    - title (str): 新标题
    - artist (Optional[str]): 新艺术家
    """

    title: str
    artist: Optional[str] = None


class DurationUpdateRequest(BaseModel):
    """
    时长更新请求模型

    - duration (float): 实际时长秒数
    """

    duration: float


class BatchDeleteRequest(BaseModel):
    """
    批量删除请求模型

    - track_ids (List[str]): 待删除歌曲 ID 列表
    """

    track_ids: List[str]
