# Narrative Bridge 真正开始监听后，向桌面宿主原子发布实际端口。
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Callable


def publish_ready(port: int) -> Callable[[], None] | None:
    ready_value = os.environ.get("EMA_READY_FILE")
    if not ready_value:
        return None

    ready_file = Path(ready_value)
    ready_file.parent.mkdir(parents=True, exist_ok=True)
    temporary_file = ready_file.with_name(f"{ready_file.name}.{os.getpid()}.tmp")
    record = {"port": port}
    temporary_file.write_text(
        json.dumps(record, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    temporary_file.replace(ready_file)

    def cleanup() -> None:
        ready_file.unlink(missing_ok=True)
        temporary_file.unlink(missing_ok=True)

    return cleanup
