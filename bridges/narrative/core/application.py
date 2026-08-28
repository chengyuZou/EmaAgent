# FastAPI 生命周期、认证、/health、/internal/configure、/internal/shutdown 与 /narrative/recall 装配。
from __future__ import annotations

import hmac
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .content import resolve_narrative_root, validate_narrative_root
from .contracts import (
    ConfigureRequest,
    RecallRequest,
    RecallResponse,
    TimelineFailureResponse,
)
from .light_rag import LightRagTimelines
from .model_client import RecallLlmClient, build_embedding_func
from .ready import publish_ready
from .recall import recall

logger = logging.getLogger(__name__)

EMA_SECRET_HEADER = "x-ema-secret"


class MissingSharedSecretError(RuntimeError):
    """缺少进程间认证密钥时拒绝启动。"""


class NarrativeNotConfiguredError(RuntimeError):
    """剧情数据或进程级 Embedding 未就绪，Narrative 能力不可用。"""


def require_shared_secret() -> str:
    secret = os.environ.get("EMA_SHARED_SECRET", "")
    if not secret:
        raise MissingSharedSecretError(
            "EMA_SHARED_SECRET 未配置，Narrative Bridge 拒绝启动"
        )
    return secret


def secrets_equal(provided: str | None, expected: str) -> bool:
    return hmac.compare_digest(
        (provided or "").encode("utf-8"), expected.encode("utf-8")
    )


def build_app(port: int) -> FastAPI:
    secret = require_shared_secret()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        narrative_root = resolve_narrative_root()
        validate_narrative_root(narrative_root)
        print(f"[narrative-bridge] content root: {narrative_root}", flush=True)

        # 时间线实例等 Server 经 /internal/configure 送达进程级 Embedding 后再建；
        # 此前进程仍可回答 /health，并对 recall 返回 503。
        app.state.narrative_root = narrative_root
        app.state.timelines = None
        app.state.startup_completed = True

        clear_ready = publish_ready(port)
        try:
            yield
        finally:
            if clear_ready is not None:
                clear_ready()
            store = app.state.timelines
            if store is not None:
                await store.close()
            app.state.timelines = None

    app = FastAPI(
        title="ema-narrative-bridge",
        description="EmaAgent Narrative LightRAG retrieval bridge",
        lifespan=lifespan,
    )
    app.state.timelines = None
    app.state.startup_completed = False

    @app.middleware("http")
    async def authenticate_server(request: Request, call_next):
        if request.url.path == "/health":
            return await call_next(request)
        if not secrets_equal(request.headers.get(EMA_SECRET_HEADER), secret):
            return JSONResponse(
                status_code=401,
                content={"error": "unauthorized"},
                headers={"Cache-Control": "no-store"},
            )
        return await call_next(request)

    @app.get("/health")
    async def health(request: Request) -> dict:
        if not getattr(request.app.state, "startup_completed", False):
            return {"status": "starting", "capabilities": {"narrative": False}}
        ready = getattr(request.app.state, "timelines", None) is not None
        return {"status": "ok", "capabilities": {"narrative": ready}}

    @app.post("/internal/configure")
    async def configure_embedding(body: ConfigureRequest, request: Request) -> JSONResponse:
        # 向量空间与既有剧情数据一体，进程内只允许配置一次；更换 Embedding 必须重启 Bridge。
        if getattr(request.app.state, "timelines", None) is not None:
            return JSONResponse(status_code=409, content={"error": "already_configured"})
        embedding = build_embedding_func(
            base_url=body.embed.base_url,
            api_key=body.embed.api_key,
            model=body.embed.model_id,
            dim=body.embed.dim,
        )
        store = LightRagTimelines(request.app.state.narrative_root, embedding)
        await store.initialize()
        request.app.state.timelines = store
        return JSONResponse(status_code=200, content={"status": "configured"})

    @app.post("/internal/shutdown")
    async def shutdown_bridge(request: Request) -> JSONResponse:
        server = getattr(request.app.state, "uvicorn_server", None)
        if server is None:
            return JSONResponse(status_code=503, content={"error": "shutdown_unavailable"})
        # 交还 uvicorn 主循环正常退出：停收新连接、排空在途请求、执行 lifespan 清理。
        server.should_exit = True
        return JSONResponse(status_code=200, content={"status": "shutting_down"})

    @app.post("/narrative/recall", response_model=RecallResponse)
    async def recall_narrative(body: RecallRequest, request: Request) -> RecallResponse:
        timelines: LightRagTimelines | None = getattr(request.app.state, "timelines", None)
        if timelines is None:
            raise NarrativeNotConfiguredError("Narrative 剧情数据或 Embedding 未就绪")

        client = RecallLlmClient(body.llm)
        try:
            recalled = await recall(
                timelines,
                client,
                body.query,
                mode=body.mode,
                top_k=body.top_k,
            )
        finally:
            await client.close()

        return RecallResponse(
            routes=recalled.routes,
            results=recalled.results,
            failures=[
                TimelineFailureResponse(
                    timeline=failure.timeline,
                    code="timeline_query_failed",
                    message=failure.message,
                )
                for failure in recalled.failures
            ],
        )

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
