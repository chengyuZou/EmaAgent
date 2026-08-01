# 组装认证、路由、剧情目录校验与 Narrative Runtime 生命周期。
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .auth import EMA_SECRET_HEADER, require_shared_secret, secrets_equal
from .errors import NarrativeNotConfiguredError
from .retrieval.contentPaths import resolve_narrative_root, validate_narrative_root
from .narrativeRuntime import NarrativeRuntime
from .readiness import publish_runtime_ready
from .routes.health import router as health_router
from .routes.internal import router as internal_router
from .routes.narrative import router as narrative_router

logger = logging.getLogger(__name__)


def build_app(shared_secret: str | None = None) -> FastAPI:
    secret = shared_secret if shared_secret is not None else require_shared_secret()
    if len(secret) < 32:
        require_shared_secret({"EMA_SHARED_SECRET": secret})

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        narrative_root = resolve_narrative_root()
        validate_narrative_root(narrative_root)
        runtime = NarrativeRuntime(narrative_root)
        app.state.narrative_runtime = runtime
        print(f"[narrative-bridge] content root: {narrative_root}", flush=True)
        clear_runtime_ready = publish_runtime_ready()
        try:
            yield
        finally:
            if clear_runtime_ready is not None:
                clear_runtime_ready()
            await runtime.close()
            app.state.narrative_runtime = None

    app = FastAPI(
        title="ema-narrative-bridge",
        version="0.1.0",
        description="EmaAgent Narrative LightRAG retrieval bridge",
        lifespan=lifespan,
    )
    app.state.narrative_runtime = None

    @app.middleware("http")
    async def authenticate_local_host(request: Request, call_next):
        if request.url.path == "/health":
            return await call_next(request)
        if not secrets_equal(request.headers.get(EMA_SECRET_HEADER), secret):
            return JSONResponse(
                status_code=401,
                content={"error": "unauthorized"},
                headers={"Cache-Control": "no-store"},
            )
        return await call_next(request)

    app.include_router(health_router)
    app.include_router(internal_router)
    app.include_router(narrative_router)

    @app.exception_handler(NarrativeNotConfiguredError)
    async def narrative_not_ready(
        _request: Request,
        _error: NarrativeNotConfiguredError,
    ) -> JSONResponse:
        return JSONResponse(
            status_code=503,
            content={"error": "narrative_not_configured"},
        )

    @app.exception_handler(Exception)
    async def unhandled_error(_request: Request, error: Exception) -> JSONResponse:
        logger.exception("Narrative Bridge request failed", exc_info=error)
        return JSONResponse(status_code=500, content={"error": "internal_error"})

    return app
