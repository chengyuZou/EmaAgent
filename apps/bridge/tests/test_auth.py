from __future__ import annotations

import httpx
import pytest

from bridge.auth import MissingSharedSecretError, require_shared_secret
from bridge.main import build_app


TEST_SECRET = "0123456789abcdef0123456789abcdef"


def test_missing_secret_is_fail_closed() -> None:
    with pytest.raises(MissingSharedSecretError):
        require_shared_secret({})
    with pytest.raises(MissingSharedSecretError):
        build_app("too-short")


@pytest.mark.asyncio
async def test_health_is_public_but_narrative_routes_require_secret() -> None:
    transport = httpx.ASGITransport(app=build_app(TEST_SECRET))
    async with httpx.AsyncClient(transport=transport, base_url="http://bridge.test") as client:
        assert (await client.get("/health")).status_code == 200

        denied = await client.post("/narrative/route", json={"query": "hello"})
        assert denied.status_code == 401
        assert "no-store" in denied.headers["cache-control"]

        authorized = await client.post(
            "/narrative/route",
            json={"query": "hello"},
            headers={"X-Ema-Secret": TEST_SECRET},
        )
        # 已通过认证但尚未配置 Narrative，应该进入业务层并返回 503。
        assert authorized.status_code == 503
