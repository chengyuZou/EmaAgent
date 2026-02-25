"""音频路由层，只做 HTTP 到 service 的转发。"""

from fastapi import APIRouter, HTTPException

from api.routes.schemas.audio import AudioListResponse, ClearAudioCacheResponse
from api.services.audio_service import get_audio_service

router = APIRouter()
audio_service = get_audio_service()


@router.get("/audio/cache/{filename}")
async def get_audio_cache(filename: str):
    return audio_service.get_audio_cache(filename)


@router.get("/audio/output/{filename}")
async def get_audio_output(filename: str):
    return audio_service.get_audio_output(filename)


@router.get("/audio/{filename}")
async def get_audio(filename: str):
    return audio_service.get_audio(filename)


@router.get("/audio/list", response_model=AudioListResponse)
async def list_audio_files() -> AudioListResponse:
    files = audio_service.list_audio_files()
    return AudioListResponse(files=files)


@router.delete("/audio/cache", response_model=ClearAudioCacheResponse)
async def clear_audio_cache() -> ClearAudioCacheResponse:
    try:
        result = audio_service.clear_audio_cache()
        return ClearAudioCacheResponse(**result)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"清除音频缓存失败: {e}")
