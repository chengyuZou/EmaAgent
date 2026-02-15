"""
音频路由模块

该模块提供缓存音频 合并音频 查询与清理接口
"""

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from config.paths import get_paths


router = APIRouter()


class AudioInfo(BaseModel):
    """
    音频文件信息模型

    - filename (str): 音频文件名
    - url (str): 音频访问地址
    - size (int): 音频文件大小
    """

    filename: str
    url: str
    size: int


def _serve_audio_file(audio_file: Path, filename: str) -> FileResponse:
    """
    返回音频文件响应

    Args:
        audio_file (Path): 音频文件路径
        filename (str): 下载文件名

    Returns:
        FileResponse: 文件响应对象

    Raises:
        HTTPException: 当文件不存在时抛出 404
    """
    # 文件不存在时返回 404
    if not audio_file.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")
    # 使用 mp3 媒体类型返回文件
    return FileResponse(path=str(audio_file), media_type="audio/mpeg", filename=filename)


@router.get("/audio/cache/{filename}")
async def get_audio_cache(filename: str):
    """
    获取缓存音频文件

    Args:
        filename (str): 目标文件名

    Returns:
        FileResponse: 音频文件响应
    """
    # 从 data/audio/cache 目录读取
    paths = get_paths()
    return _serve_audio_file(paths.audio_cache_dir / filename, filename)


@router.get("/audio/output/{filename}")
async def get_audio_output(filename: str):
    """
    获取合并音频文件

    Args:
        filename (str): 目标文件名

    Returns:
        FileResponse: 音频文件响应
    """
    # 从 data/audio/output 目录读取
    paths = get_paths()
    return _serve_audio_file(paths.audio_output_dir / filename, filename)


@router.get("/audio/{filename}")
async def get_audio(filename: str):
    """
    兼容旧路径读取音频

    读取顺序为 cache 优先 output 回退

    Args:
        filename (str): 目标文件名

    Returns:
        FileResponse: 音频文件响应
    """
    paths = get_paths()
    # 先尝试读取缓存分段音频
    audio_file = paths.audio_cache_dir / filename
    if not audio_file.exists():
        # 缓存不存在时回退读取合并音频
        audio_file = paths.audio_output_dir / filename
    return _serve_audio_file(audio_file, filename)


@router.get("/audio/list")
async def list_audio_files():
    """
    列出缓存音频文件

    Args:
        None

    Returns:
        Dict[str list[AudioInfo]]: 缓存文件列表
    """
    paths = get_paths()
    files = []
    # 扫描 cache 目录下全部 mp3 文件
    for audio_file in paths.audio_cache_dir.glob("*.mp3"):
        files.append(
            AudioInfo(
                filename=audio_file.name,
                url=f"/audio/cache/{audio_file.name}",
                size=audio_file.stat().st_size,
            )
        )
    return {"files": files}


@router.delete("/audio/cache")
async def clear_audio_cache():
    """
    清理缓存音频目录

    Args:
        None

    Returns:
        Dict[str str]: 清理结果

    Raises:
        HTTPException: 清理失败时抛出 500
    """
    paths = get_paths()
    try:
        # max_age_hours 为 0 表示清理全部缓存
        paths.cleanup_audio_cache(max_age_hours=0)
        return {"status": "cleared"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"清除音频缓存失败: {e}")
