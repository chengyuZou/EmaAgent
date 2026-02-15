"""
音乐路由模块

该模块提供播放列表 查询 上传 单曲管理 封面管理 格式转换 与文件访问接口
"""

from typing import List, Optional
from pathlib import Path
import shutil

from fastapi import APIRouter, UploadFile, File, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

from config.paths import get_paths
from api.services.music_service import get_music_service

router = APIRouter()


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


# 单曲字段白名单 用于安全映射服务层字典
_TRACK_FIELDS = ["id", "title", "artist", "url", "duration",
                 "play_count", "last_played", "is_favorited", "cover_art"]


def _to_track_info(t: dict) -> TrackInfo:
    """
    将字典转换为 TrackInfo

    Args:
        t (dict): 服务层返回的单曲字典

    Returns:
        TrackInfo: 转换后的模型对象
    """
    # 仅提取允许字段 防止多余字段污染响应
    return TrackInfo(**{k: t.get(k) for k in _TRACK_FIELDS})


@router.get("/music/playlist", response_model=PlaylistResponse)
async def get_playlist():
    """
    获取播放列表

    Returns:
        PlaylistResponse: 排序后的播放列表响应
    """
    service = get_music_service()
    # 服务层负责排序规则
    tracks = service.get_playlist(sorted_=True)
    return PlaylistResponse(
        tracks=[_to_track_info(t) for t in tracks],
        total=len(tracks),
    )


@router.post("/music/refresh")
async def refresh_playlist():
    """
    刷新播放列表

    Returns:
        Dict[str Any]: 刷新结果字典
    """
    service = get_music_service()
    # 重新扫描目录并更新索引
    tracks = service.refresh()
    return {"status": "refreshed", "total": len(tracks)}


@router.get("/music/search")
async def search_music(query: str = Query(..., description="搜索关键词")):
    """
    按关键词搜索音乐

    Args:
        query (str): 搜索关键词

    Returns:
        Dict[str Any]: 搜索结果字典
    """
    service = get_music_service()
    # 执行本地索引搜索
    tracks = service.search_local(query)
    return {
        "tracks": [_to_track_info(t) for t in tracks],
        "total": len(tracks),
    }


@router.post("/music/upload")
async def upload_music(
    file: UploadFile = File(...),
    title: Optional[str] = None,
    artist: Optional[str] = None,
):
    """
    上传音乐文件

    Args:
        file (UploadFile): 上传文件
        title (Optional[str]): 可选标题
        artist (Optional[str]): 可选艺术家

    Returns:
        Dict[str Any]: 上传结果字典

    Raises:
        HTTPException: 当文件类型不支持时抛出 400
    """
    paths = get_paths()
    music_dir = paths.music_dir
    # 确保音乐目录存在
    music_dir.mkdir(parents=True, exist_ok=True)

    allowed_types = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"}
    file_ext = Path(file.filename).suffix.lower()
    if file_ext not in allowed_types:
        raise HTTPException(status_code=400, detail=f"不支持的文件类型: {file_ext}")

    # 将上传文件写入磁盘
    file_path = music_dir / file.filename
    with open(file_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    # 写入服务层索引并返回单曲信息
    service = get_music_service()
    track = service.add_track(str(file_path), title=title, artist=artist)
    return {"status": "uploaded", "track": track}


@router.post("/music/{track_id}/play")
async def record_play(track_id: str):
    """
    记录单曲播放

    Args:
        track_id (str): 单曲标识

    Returns:
        Dict[str Any]: 播放记录结果

    Raises:
        HTTPException: 当单曲不存在时抛出 404
    """
    service = get_music_service()
    track = service.record_play(track_id)
    if not track:
        raise HTTPException(status_code=404, detail="歌曲不存在")
    return {"status": "ok", "play_count": track["play_count"], "last_played": track["last_played"]}


@router.post("/music/{track_id}/favorite")
async def toggle_favorite(track_id: str):
    """
    切换收藏状态

    Args:
        track_id (str): 单曲标识

    Returns:
        Dict[str Any]: 收藏状态结果

    Raises:
        HTTPException: 当单曲不存在时抛出 404
    """
    service = get_music_service()
    track = service.toggle_favorite(track_id)
    if not track:
        raise HTTPException(status_code=404, detail="歌曲不存在")
    return {"status": "ok", "is_favorited": track["is_favorited"]}


@router.put("/music/{track_id}/rename")
async def rename_track(track_id: str, body: RenameRequest):
    """
    重命名单曲信息

    Args:
        track_id (str): 单曲标识
        body (RenameRequest): 重命名请求体

    Returns:
        Dict[str Any]: 重命名结果

    Raises:
        HTTPException: 当单曲不存在时抛出 404
    """
    service = get_music_service()
    track = service.rename_track(track_id, body.title, body.artist)
    if not track:
        raise HTTPException(status_code=404, detail="歌曲不存在")
    return {"status": "ok", "track": _to_track_info(track)}


@router.put("/music/{track_id}/duration")
async def update_duration(track_id: str, body: DurationUpdateRequest):
    """
    更新单曲时长

    Args:
        track_id (str): 单曲标识
        body (DurationUpdateRequest): 时长更新请求体

    Returns:
        Dict[str Any]: 时长更新结果

    Raises:
        HTTPException: 当单曲不存在时抛出 404
    """
    service = get_music_service()
    track = service.update_duration(track_id, body.duration)
    if not track:
        raise HTTPException(status_code=404, detail="歌曲不存在")
    return {"status": "ok", "duration": track["duration"]}


@router.post("/music/{track_id}/cover")
async def upload_cover(track_id: str, file: UploadFile = File(...)):
    """
    上传单曲封面图片

    Args:
        track_id (str): 单曲标识
        file (UploadFile): 上传图片文件

    Returns:
        Dict[str Any]: 封面更新结果

    Raises:
        HTTPException: 当图片格式不支持或单曲不存在时抛出错误
    """
    paths = get_paths()
    covers_dir = paths.music_dir / "covers"
    # 确保封面目录存在
    covers_dir.mkdir(parents=True, exist_ok=True)

    allowed_img = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
    file_ext = Path(file.filename).suffix.lower()
    if file_ext not in allowed_img:
        raise HTTPException(status_code=400, detail=f"不支持的图片格式: {file_ext}")

    # 封面命名使用 track_id 保持唯一
    save_name = f"{track_id}{file_ext}"
    save_path = covers_dir / save_name
    with open(save_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    cover_url = f"/api/music/covers/{save_name}"
    service = get_music_service()
    track = service.update_cover(track_id, cover_url)
    if not track:
        raise HTTPException(status_code=404, detail="歌曲不存在")
    return {"status": "ok", "cover_art": cover_url}


@router.get("/music/covers/{filename}")
async def get_cover(filename: str):
    """
    获取封面文件

    Args:
        filename (str): 封面文件名

    Returns:
        FileResponse: 封面文件响应

    Raises:
        HTTPException: 当封面不存在时抛出 404
    """
    paths = get_paths()
    cover_path = paths.music_dir / "covers" / filename
    if not cover_path.exists():
        raise HTTPException(status_code=404, detail="封面不存在")

    # 根据后缀推断媒体类型
    suffix = cover_path.suffix.lower()
    media_map = {".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                 ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif"}
    return FileResponse(str(cover_path), media_type=media_map.get(suffix, "image/jpeg"))


@router.post("/music/{track_id}/convert")
async def convert_track(track_id: str, target_format: str = Query(..., description="目标格式，如 mp3 / wav / flac")):
    """
    转换音频格式并返回下载文件

    Args:
        track_id (str): 单曲标识
        target_format (str): 目标格式

    Returns:
        FileResponse: 转换后文件响应

    Raises:
        HTTPException: 当目标格式不支持或转换失败时抛出错误
    """
    allowed_formats = {"mp3", "wav", "flac", "ogg", "m4a", "aac"}
    fmt = target_format.lower().lstrip(".")
    if fmt not in allowed_formats:
        raise HTTPException(status_code=400, detail=f"不支持的目标格式: {fmt}")

    service = get_music_service()
    result_path = service.convert_track(track_id, fmt)
    if not result_path or not result_path.exists():
        raise HTTPException(
            status_code=500,
            detail="转换失败，请确认服务器已安装 ffmpeg 或 pydub",
        )

    # 根据目标格式返回对应媒体类型
    media_map = {
        "mp3": "audio/mpeg", "wav": "audio/wav", "flac": "audio/flac",
        "ogg": "audio/ogg", "m4a": "audio/mp4", "aac": "audio/aac",
    }
    return FileResponse(
        path=str(result_path),
        media_type=media_map.get(fmt, "audio/mpeg"),
        filename=result_path.name,
        headers={"Content-Disposition": f'attachment; filename="{result_path.name}"'},
    )


@router.get("/music/{filename}")
async def get_music_file(filename: str):
    """
    获取音乐文件流

    Args:
        filename (str): 文件名

    Returns:
        FileResponse: 音频文件响应

    Raises:
        HTTPException: 当文件不存在时抛出 404
    """
    paths = get_paths()
    music_dir = paths.music_dir
    file_path = music_dir / filename

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="文件不存在")

    # 根据后缀匹配媒体类型
    suffix = file_path.suffix.lower()
    media_map = {
        ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac",
        ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".aac": "audio/aac",
    }
    return FileResponse(
        path=str(file_path),
        media_type=media_map.get(suffix, "audio/mpeg"),
        filename=filename,
    )


@router.delete("/music/{track_id}")
async def delete_track(track_id: str):
    """
    删除单曲

    Args:
        track_id (str): 单曲标识

    Returns:
        Dict[str str]: 删除结果字典

    Raises:
        HTTPException: 当单曲不存在时抛出 404
    """
    service = get_music_service()
    if service.remove_track(track_id):
        return {"status": "deleted", "track_id": track_id}
    raise HTTPException(status_code=404, detail="歌曲不存在")


@router.post("/music/batch-delete")
async def batch_delete_tracks(body: BatchDeleteRequest):
    """
    批量删除歌曲

    Args:
        body (BatchDeleteRequest): 批量删除请求体

    Returns:
        Dict[str Any]: 批量删除结果
    """
    service = get_music_service()
    result = service.remove_tracks(body.track_ids)
    return {
        "status": "ok",
        "removed": result["removed"],
        "missing": result["missing"],
        "removed_count": len(result["removed"]),
        "missing_count": len(result["missing"]),
    }
