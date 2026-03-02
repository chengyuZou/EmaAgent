"""
EmaAgent FastAPI 服务入口

提供 REST API 和 WebSocket 接口
"""
import asyncio
import sys
from pathlib import Path

# 确保项目根目录在 sys.path 中
PROJECT_ROOT = Path(__file__).parent.parent.resolve()
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from agent.EmaAgent import get_agent

from config.paths import init_paths
# 初始化路径配置
paths = init_paths(PROJECT_ROOT)
paths.ensure_directories()
from api.routes import chat, sessions, audio, settings, news, music, live2d, game
from utils.logger import logger



# 创建 FastAPI 应用
app = FastAPI(
    title="EmaAgent API",
    description="EmaAgent 智能助手 API 服务",
    version="0.2.0"
)



# CORS 配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册路由
app.include_router(chat.router, prefix="/api", tags=["Chat"])
app.include_router(sessions.router, prefix="/api", tags=["Sessions"])
app.include_router(audio.router, prefix="/api", tags=["Audio"])
app.include_router(settings.router, prefix="/api", tags=["Settings"])
app.include_router(news.router)
app.include_router(music.router, prefix="/api", tags=["Music"])
app.include_router(live2d.router, prefix="/api")  
app.include_router(game.router, prefix="/api/game", tags=["Game"])

@app.on_event("startup")
async def warmup_on_startup():
    """预热 Narrative LightRAG + MCP 工具，减少首次请求的延迟"""
    _ema_agent = get_agent(server_mode=True)

    # 预热 Narrative
    try:
        await _ema_agent.initialize_narrative()
        logger.info("✅ [Startup] Narrative LightRAG 预热完成")
    except Exception as exc:
        logger.error(f"❌ [Startup] Narrative 预热失败: {exc}")

    # 启动 MCP Server 并注入工具
    try:
        await _ema_agent.initialize_mcp()
        logger.info("✅ [Startup] MCP 工具初始化完成")
    except Exception as exc:
        logger.error(f"❌ [Startup] MCP 工具初始化失败: {exc}")


@app.on_event("shutdown")
async def shutdown_cleanup():
    """关闭时释放 MCP Server 等资源"""
    try:
        _ema_agent = get_agent(server_mode=True)
        await _ema_agent.close()
        logger.info("✅ [Shutdown] 资源清理完成")
    except asyncio.CancelledError as exc:
        logger.warning(f"⚠️ [Shutdown] 资源清理被取消，继续退出: {exc}")
    except Exception as exc:
        logger.error(f"❌ [Shutdown] 资源清理失败: {exc}")


# ==================== 音频文件服务（核心路由，优先级最高）====================
audio_output = paths.audio_output_dir
audio_cache = paths.audio_cache_dir
audio_cache.mkdir(parents=True, exist_ok=True)

logger.info(f"🎵 [Audio Setup] 音频缓存目录: {audio_cache}")
logger.info(f"🎵 [Audio Setup] 音频输出目录: {audio_output}")

@app.get("/audio/debug/list")
async def debug_list_audio_files():
    """🔍 调试：列出所有音频文件"""
    try:
        cache_files = list(audio_cache.glob("*.mp3"))
        output_files = list(audio_output.glob("*.mp3"))
        
        return {
            "cache_dir": str(audio_cache),
            "cache_files": [f.name for f in cache_files],
            "cache_count": len(cache_files),
            "output_dir": str(audio_output),
            "output_files": [f.name for f in output_files],
            "output_count": len(output_files),
        }
    except Exception as e:
        return {"error": str(e)}

@app.get("/audio/cache/{filename}")
async def serve_audio_cache_short(filename: str):
    """🎵 音频缓存文件服务（前端请求的短路径）"""
    file_path = audio_cache / filename
    logger.info(f"🎵 [Audio Request] 请求文件: {filename}")
    logger.info(f"🎵 [Audio Request] 完整路径: {file_path}")
    logger.info(f"🎵 [Audio Request] 文件存在: {file_path.exists()}")
    
    if file_path.exists() and file_path.is_file():
        file_size = file_path.stat().st_size
        logger.info(f"✅ [Audio Found] 文件大小: {file_size} bytes")
        return FileResponse(
            str(file_path), 
            media_type="audio/mpeg",
            headers={
                "Accept-Ranges": "bytes",
                "Cache-Control": "public, max-age=3600"
            }
        )
    
    # 列出目录中的所有文件
    try:
        existing_files = list(audio_cache.glob("*.mp3"))
        logger.info(f"❌ [Audio NotFound] 目录中的文件: {[f.name for f in existing_files]}")
    except Exception as e:
        logger.error(f"❌ [Audio Error] 无法列出文件: {e}")
    
    raise HTTPException(status_code=404, detail=f"音频文件不存在: {filename}")

@app.get("/audio/output/cache/{filename}")
async def serve_audio_cache(filename: str):
    """音频缓存文件服务（完整路径）"""
    file_path = audio_cache / filename
    if file_path.exists() and file_path.is_file():
        return FileResponse(str(file_path), media_type="audio/mpeg")
    raise HTTPException(status_code=404, detail="音频文件不存在")

@app.get("/audio/output/{filename}")
async def serve_audio_output(filename: str):
    """音频输出文件服务"""
    file_path = audio_output / filename
    if file_path.exists() and file_path.is_file():
        return FileResponse(str(file_path), media_type="audio/mpeg")
    raise HTTPException(status_code=404, detail="音频文件不存在")

# ==================== 静态文件服务 ====================

# 静态文件（Live2D 模型）
live2d_dir = paths.live2d_ema_dir
if live2d_dir.exists():
    app.mount("/live2d/ema", StaticFiles(directory=str(live2d_dir)), name="live2d_ema")

puzzle_dir = paths.puzzle_dir
if puzzle_dir.exists():
    app.mount("/static/puzzles", StaticFiles(directory=str(puzzle_dir)), name="puzzles")

uploads_dir = paths.uploads_dir
app.mount("/uploads", StaticFiles(directory=str(uploads_dir)), name="uploads")

# 静态文件服务
frontend_dist = paths.frontend_dist_dir
frontend_public = paths.frontend_public_dir

# 复制 public 目录的文件到 dist（开发时）
if frontend_public.exists():
    import shutil
    for f in frontend_public.glob("*"):
        if f.is_file():
            dest = frontend_dist / f.name
            if not dest.exists() or f.stat().st_mtime > dest.stat().st_mtime:
                shutil.copy2(f, dest)

if frontend_dist.exists():
    # 挂载 assets 目录（如果存在）
    assets_dir = frontend_dist / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")
    
    @app.get("/")
    async def serve_index():
        index_file = frontend_dist / "index.html"
        if index_file.exists():
            return FileResponse(str(index_file))
        # 开发模式：重定向到 Vite 开发服务器
        from fastapi.responses import RedirectResponse
        return RedirectResponse(url="http://localhost:5173")
    
    @app.get("/{catch_all:path}")
    async def serve_spa(catch_all: str):
        """SPA 路由回退（音频请求已在上面的路由中处理）"""
        file_path = frontend_dist / catch_all
        if file_path.exists() and file_path.is_file():
            return FileResponse(str(file_path))
        # 检查 public 目录
        public_file = frontend_public / catch_all
        if public_file.exists() and public_file.is_file():
            return FileResponse(str(public_file))
        # 回退到 index.html
        index_file = frontend_dist / "index.html"
        if index_file.exists():
            return FileResponse(str(index_file))
        return {"error": "Not found"}


@app.get("/health")
async def health_check():
    """健康检查"""
    return {"status": "healthy", "version": "0.2.0"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "api.main:app",
        host="0.0.0.0",
        port=8000,
        reload=True
    )
