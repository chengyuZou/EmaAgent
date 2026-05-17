from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from bridge.routes.health    import router as health_router
from bridge.routes.internal  import router as internal_router
from bridge.routes.narrative import router as narrative_router


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield


def build_app() -> FastAPI:
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


app = build_app()
