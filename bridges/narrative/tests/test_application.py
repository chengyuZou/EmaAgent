# 测试 Narrative Bridge 的认证默认拒绝、健康公开、configure 一次语义与未配置响应。
from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from core.application import (
    MissingSharedSecretError,
    build_app,
    require_shared_secret,
)
from core.content import TIMELINES

TEST_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
EMBED_BODY = {
    "embed": {
        "baseUrl": "http://embed.test/v1",
        "modelId": "test-embed",
        "dim": 8,
    }
}


def _make_narrative_root(tmp_path: Path) -> Path:
    for timeline in TIMELINES:
        (tmp_path / timeline).mkdir()
    return tmp_path


def test_missing_secret_is_fail_closed(monkeypatch) -> None:
    monkeypatch.delenv("EMA_SHARED_SECRET", raising=False)
    with pytest.raises(MissingSharedSecretError):
        require_shared_secret()
    with pytest.raises(MissingSharedSecretError):
        build_app(7421)


@pytest.mark.asyncio
async def test_health_is_public_but_business_routes_require_secret(monkeypatch) -> None:
    monkeypatch.setenv("EMA_SHARED_SECRET", TEST_SECRET)
    app = build_app(7421)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://bridge.test") as client:
        health = await client.get("/health")
        assert health.status_code == 200
        assert health.json()["status"] == "starting"
        assert health.json()["capabilities"] == {"narrative": False}

        for path, body in (
            ("/narrative/recall", {"query": "hello"}),
            ("/internal/configure", EMBED_BODY),
            ("/internal/shutdown", None),
        ):
            denied = await client.post(path, json=body)
            assert denied.status_code == 401
            assert "no-store" in denied.headers["cache-control"]


@pytest.mark.asyncio
async def test_recall_without_runtime_is_not_configured(monkeypatch) -> None:
    # ASGITransport 不跑 lifespan：timelines 未就绪时应 503 而不是 5xx。
    monkeypatch.setenv("EMA_SHARED_SECRET", TEST_SECRET)
    app = build_app(7421)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://bridge.test") as client:
        authorized = await client.post(
            "/narrative/recall",
            json={
                "query": "hello",
                "llm": {"baseUrl": "http://llm.test/v1", "modelId": "test-model"},
            },
            headers={"X-Ema-Secret": TEST_SECRET},
        )
        assert authorized.status_code == 503
        assert authorized.json() == {"error": "narrative_not_configured"}


@pytest.mark.asyncio
async def test_second_configure_is_rejected(monkeypatch, tmp_path) -> None:
    # 真实 LightRAG 建库走集成冒烟；这里直接占用 timelines 验证一次语义。
    monkeypatch.setenv("EMA_SHARED_SECRET", TEST_SECRET)
    app = build_app(7421)
    app.state.narrative_root = _make_narrative_root(tmp_path)
    app.state.timelines = object()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://bridge.test") as client:
        response = await client.post(
            "/internal/configure",
            json=EMBED_BODY,
            headers={"X-Ema-Secret": TEST_SECRET},
        )
        assert response.status_code == 409
        assert response.json() == {"error": "already_configured"}


@pytest.mark.asyncio
async def test_shutdown_requires_uvicorn_handle(monkeypatch) -> None:
    monkeypatch.setenv("EMA_SHARED_SECRET", TEST_SECRET)
    app = build_app(7421)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://bridge.test") as client:
        response = await client.post(
            "/internal/shutdown",
            headers={"X-Ema-Secret": TEST_SECRET},
        )
        assert response.status_code == 503
        assert response.json() == {"error": "shutdown_unavailable"}
