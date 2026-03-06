"""
设置路由模块。

本文件仅保留 HTTP 路由映射，具体业务逻辑由 settings_service 承载。
"""

from fastapi import APIRouter

from api.routes.schemas.settings import (
    ApiConfigModel,
    DeleteMcpServerResponse,
    DirectoryPickerRequest,
    ImportMcpPasteRequest,
    ImportMcpPasteResponse,
    PathConfigModel,
    SwitchModelRequest,
    SwitchTtsProviderRequest,
    SystemStatusResponse,
    TtsConfigModel,
    UiFontModel,
    UiThemeModel,
    UpdateMcpServerEnvRequest,
    UpdateMcpServerEnvResponse,
    UpdateMcpSettingsRequest,
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


@router.put("/settings/api")
async def update_api_settings(api: ApiConfigModel):
    return await _settings_service.update_api_settings(api)


@router.get("/settings/models")
async def list_models():
    return await _settings_service.list_models()


@router.put("/settings/model")
async def switch_model(request: SwitchModelRequest):
    return await _settings_service.switch_model(request)


@router.get("/settings/paths")
async def get_paths_info():
    return await _settings_service.get_paths_info()


@router.put("/settings/paths")
async def update_paths_settings(paths: PathConfigModel):
    return await _settings_service.update_paths_settings(paths)


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


@router.get("/settings/mcp")
async def get_mcp_settings():
    return await _settings_service.get_mcp_settings()


@router.put("/settings/mcp")
async def update_mcp_settings(request: UpdateMcpSettingsRequest):
    return await _settings_service.update_mcp_settings(request)

@router.post("/settings/mcp/import-paste", response_model=ImportMcpPasteResponse)
async def import_mcp_from_paste(request: ImportMcpPasteRequest):
    return await _settings_service.import_mcp_from_paste(request)


@router.patch("/settings/mcp/server/{server_name}/env", response_model=UpdateMcpServerEnvResponse)
async def update_mcp_server_env(server_name: str, request: UpdateMcpServerEnvRequest):
    return await _settings_service.update_mcp_server_env(server_name, request)


@router.delete("/settings/mcp/server/{server_name}", response_model=DeleteMcpServerResponse)
async def delete_mcp_server(server_name: str):
    return await _settings_service.delete_mcp_server(server_name)
