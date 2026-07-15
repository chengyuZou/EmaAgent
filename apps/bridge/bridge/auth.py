from __future__ import annotations

import hashlib
import hmac
import os
from collections.abc import Mapping

EMA_SECRET_HEADER = "x-ema-secret"
MIN_SECRET_LENGTH = 32


class MissingSharedSecretError(RuntimeError):
    """Bridge 缺少进程间认证密钥，必须拒绝启动。"""


def require_shared_secret(env: Mapping[str, str] = os.environ) -> str:
    secret = env.get("EMA_SHARED_SECRET", "")
    if len(secret) < MIN_SECRET_LENGTH:
        raise MissingSharedSecretError(
            "EMA_SHARED_SECRET 未配置或长度不足，Bridge 拒绝以无认证模式启动"
        )
    return secret


def secrets_equal(provided: str | None, expected: str) -> bool:
    provided_digest = hashlib.sha256((provided or "").encode("utf-8")).digest()
    expected_digest = hashlib.sha256(expected.encode("utf-8")).digest()
    return hmac.compare_digest(provided_digest, expected_digest)
