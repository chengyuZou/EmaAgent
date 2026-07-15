from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from bridge.routes.health    import router as health_router
from bridge.routes.internal  import router as internal_router
from bridge.routes.narrative import router as narrative_router
from bridge.state import state
from bridge.auth import require_shared_secret, secrets_equal


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    if state.narrative_manager is not None:
        await state.narrative_manager.finalize()


def build_app(shared_secret: str | None = None) -> FastAPI:
    secret = shared_secret if shared_secret is not None else require_shared_secret()
    if len(secret) < 32:
        # 显式注入主要供测试使用，但仍不允许构造 fail-open 应用。
        require_shared_secret({"EMA_SHARED_SECRET": secret})

    app = FastAPI(
        title="ema-bridge",
        version="0.1.0",
        description="EmaAgent compute bridge — LightRAG narrative retrieval",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost", "http://127.0.0.1"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def authenticate_sidecar_request(request: Request, call_next):
        # 健康检查只返回就绪状态，供 Tauri/Core 探活，不暴露用户数据。
        if request.url.path == "/health":
            return await call_next(request)

        if not secrets_equal(request.headers.get("x-ema-secret"), secret):
            return JSONResponse(
                status_code=401,
                content={"error": "unauthorized"},
                headers={"Cache-Control": "no-store"},
            )
        return await call_next(request)

    app.include_router(health_router)
    app.include_router(internal_router)
    app.include_router(narrative_router)

    @app.exception_handler(Exception)
    async def _unhandled(_req: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content={"error": "internal_error", "detail": str(exc)},
        )

    return app
