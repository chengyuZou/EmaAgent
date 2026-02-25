"""
Music routes.
"""

import shutil
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse

from api.routes.schemas.music import (
    BatchDeleteRequest,
    DurationUpdateRequest,
    PlaylistResponse,
    RenameRequest,
    TrackInfo,
)
from api.services.music_service import get_music_service
from config.paths import get_paths

router = APIRouter()


_TRACK_FIELDS = [
    "id",
    "title",
    "artist",
    "url",
    "duration",
    "play_count",
    "last_played",
    "is_favorited",
    "cover_art",
]


def _to_track_info(t: dict) -> TrackInfo:
    """
    将字典转换为 TrackInfo
    """
    return TrackInfo(**{k: t.get(k) for k in _TRACK_FIELDS})


@router.get("/music/playlist", response_model=PlaylistResponse)
async def get_playlist():
    """
    获取播放列表
    """
    service = get_music_service()
    tracks = service.get_playlist(sorted_=True)
    return PlaylistResponse(
        tracks=[_to_track_info(t) for t in tracks],
        total=len(tracks),
    )


@router.post("/music/refresh")
async def refresh_playlist():
    """
    刷新播放列表
    """
    service = get_music_service()
    tracks = service.refresh()
    return {"status": "refreshed", "total": len(tracks)}


@router.get("/music/search")
async def search_music(query: str = Query(..., description="搜索关键词")):
    """
    按关键词搜索音乐
    """
    service = get_music_service()
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
    """
    paths = get_paths()
    music_dir = paths.music_dir
    music_dir.mkdir(parents=True, exist_ok=True)

    allowed_types = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"}
    file_ext = Path(file.filename).suffix.lower()
    if file_ext not in allowed_types:
        raise HTTPException(status_code=400, detail=f"不支持的文件类型: {file_ext}")

    file_path = music_dir / file.filename
    with open(file_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    service = get_music_service()
    track = service.add_track(str(file_path), title=title, artist=artist)
    return {"status": "uploaded", "track": track}


@router.post("/music/{track_id}/play")
async def record_play(track_id: str):
    """
    记录单曲播放
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
    """
    paths = get_paths()
    covers_dir = paths.music_dir / "covers"
    covers_dir.mkdir(parents=True, exist_ok=True)

    allowed_img = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
    file_ext = Path(file.filename).suffix.lower()
    if file_ext not in allowed_img:
        raise HTTPException(status_code=400, detail=f"不支持的图片格式: {file_ext}")

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
    """
    paths = get_paths()
    cover_path = paths.music_dir / "covers" / filename
    if not cover_path.exists():
        raise HTTPException(status_code=404, detail="封面不存在")

    suffix = cover_path.suffix.lower()
    media_map = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }
    return FileResponse(str(cover_path), media_type=media_map.get(suffix, "image/jpeg"))


@router.post("/music/{track_id}/convert")
async def convert_track(track_id: str, target_format: str = Query(..., description="目标格式，如 mp3/wav/flac")):
    """
    转换音频格式并返回下载文件
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

    media_map = {
        "mp3": "audio/mpeg",
        "wav": "audio/wav",
        "flac": "audio/flac",
        "ogg": "audio/ogg",
        "m4a": "audio/mp4",
        "aac": "audio/aac",
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
    """
    paths = get_paths()
    music_dir = paths.music_dir
    file_path = music_dir / filename

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="文件不存在")

    suffix = file_path.suffix.lower()
    media_map = {
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".flac": "audio/flac",
        ".ogg": "audio/ogg",
        ".m4a": "audio/mp4",
        ".aac": "audio/aac",
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
    """
    service = get_music_service()
    if service.remove_track(track_id):
        return {"status": "deleted", "track_id": track_id}
    raise HTTPException(status_code=404, detail="歌曲不存在")


@router.post("/music/batch-delete")
async def batch_delete_tracks(body: BatchDeleteRequest):
    """
    批量删除歌曲
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
