# 向桌面宿主原子发布 Narrative Bridge 的端口与进程握手。
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Callable

RUNTIME_PROTOCOL_VERSION = 1


def publish_runtime_ready() -> Callable[[], None] | None:
    ready_value = os.environ.get("EMA_READY_FILE")
    nonce = os.environ.get("EMA_RUNTIME_NONCE")
    port_value = os.environ.get("EMA_NARRATIVE_BRIDGE_PORT")
    if not ready_value or not nonce or not port_value:
        return None

    configured_protocol = int(
        os.environ.get("EMA_RUNTIME_PROTOCOL_VERSION", str(RUNTIME_PROTOCOL_VERSION))
    )
    if configured_protocol != RUNTIME_PROTOCOL_VERSION:
        raise RuntimeError(
            "runtime protocol mismatch: "
            f"host={configured_protocol}, narrativeBridge={RUNTIME_PROTOCOL_VERSION}"
        )

    ready_file = Path(ready_value)
    ready_file.parent.mkdir(parents=True, exist_ok=True)
    temporary_file = ready_file.with_name(f"{ready_file.name}.{os.getpid()}.tmp")
    record = {
        "service": "narrative-bridge",
        "pid": os.getpid(),
        "port": int(port_value),
        "nonce": nonce,
        "protocolVersion": RUNTIME_PROTOCOL_VERSION,
    }
    temporary_file.write_text(
        json.dumps(record, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    temporary_file.replace(ready_file)

    def cleanup() -> None:
        ready_file.unlink(missing_ok=True)
        temporary_file.unlink(missing_ok=True)

    return cleanup
