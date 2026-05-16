from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from bridge.routes.health   import router as health_router
from bridge.routes.internal import router as internal_router
from bridge.routes.embed    import router as embed_router
from bridge.routes.rerank   import router as rerank_router


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Nothing to set up at startup — configuration arrives via /internal/configure.
    yield
    # Nothing to tear down — HTTP clients are per-request (httpx) or gc'd.


def build_app() -> FastAPI:
    app = FastAPI(
        title="ema-bridge",
        version="0.1.0",
        description="EmaAgent compute bridge — embedding, rerank, LightRAG",
        lifespan=lifespan,
    )

    # Only accept connections from localhost (Tauri sidecar IPC pattern).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost", "http://127.0.0.1"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health_router)
    app.include_router(internal_router)
    app.include_router(embed_router)
    app.include_router(rerank_router)

    @app.exception_handler(Exception)
    async def _unhandled(_req: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content={"error": "internal_error", "detail": str(exc)},
        )

    return app


app = build_app()
