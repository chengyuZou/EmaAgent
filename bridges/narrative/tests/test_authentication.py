# 测试 Narrative Bridge 的认证默认拒绝和未配置响应。
from __future__ import annotations

import httpx
import pytest

from narrativeBridge.application import build_app
from narrativeBridge.auth import MissingSharedSecretError, require_shared_secret

TEST_SECRET = "0123456789abcdef0123456789abcdef"


def test_missing_secret_is_fail_closed() -> None:
    with pytest.raises(MissingSharedSecretError):
        require_shared_secret({})
    with pytest.raises(MissingSharedSecretError):
        build_app("too-short")


@pytest.mark.asyncio
async def test_health_is_public_but_recall_requires_secret() -> None:
    app = build_app(TEST_SECRET)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://bridge.test") as client:
        health = await client.get("/health")
        assert health.status_code == 200
        assert health.json()["status"] == "starting"

        denied = await client.post("/narrative/recall", json={"query": "hello"})
        assert denied.status_code == 401
        assert "no-store" in denied.headers["cache-control"]

        authorized = await client.post(
            "/narrative/recall",
            json={"query": "hello"},
            headers={"X-Ema-Secret": TEST_SECRET},
        )
        assert authorized.status_code == 503
        assert authorized.json() == {"error": "narrative_not_configured"}
