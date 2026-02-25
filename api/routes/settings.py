"""
设置路由模块。

本文件仅保留 HTTP 路由映射，具体业务逻辑由 settings_service 承载。
"""

from fastapi import APIRouter

from api.routes.schemas.settings import (
    DirectoryPickerRequest,
    SwitchModelRequest,
    SwitchTtsProviderRequest,
    SystemStatusResponse,
    TtsConfigModel,
    UiFontModel,
    UiThemeModel,
    UpdateSettingsRequest,
)
from api.services.settings_service import get_settings_service

router = APIRouter()
_settings_service = get_settings_service()


@router.get("/settings")
async def get_settings():
    return await _settings_service.get_settings()


@router.put("/settings")
async def update_settings(request: UpdateSettingsRequest):
    return await _settings_service.update_settings(request)


@router.get("/settings/models")
async def list_models():
    return await _settings_service.list_models()


@router.put("/settings/model")
async def switch_model(request: SwitchModelRequest):
    return await _settings_service.switch_model(request)


@router.get("/settings/paths")
async def get_paths_info():
    return await _settings_service.get_paths_info()


@router.post("/settings/pick-directory")
async def pick_directory(request: DirectoryPickerRequest):
    return await _settings_service.pick_directory(request)


@router.get("/settings/status", response_model=SystemStatusResponse)
async def get_system_status():
    return await _settings_service.get_system_status()


@router.get("/settings/theme")
async def get_theme_settings():
    return await _settings_service.get_theme_settings()


@router.put("/settings/theme")
async def update_theme_settings(theme: UiThemeModel):
    return await _settings_service.update_theme_settings(theme)


@router.get("/settings/font")
async def get_font_settings():
    return await _settings_service.get_font_settings()


@router.put("/settings/font")
async def update_font_settings(font: UiFontModel):
    return await _settings_service.update_font_settings(font)


@router.get("/settings/tts", response_model=TtsConfigModel)
async def get_tts_settings():
    return await _settings_service.get_tts_settings()


@router.post("/settings/tts/switch")
async def switch_tts_provider(body: SwitchTtsProviderRequest):
    return await _settings_service.switch_tts_provider(body)
