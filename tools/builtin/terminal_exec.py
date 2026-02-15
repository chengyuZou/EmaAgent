import asyncio
import subprocess
from pathlib import Path

from config.paths import get_paths
from tools.base import ToolFailure, ToolResult

from ..base import BaseTool


class TerminalExecutorTool(BaseTool):
    """在受限规则下执行终端命令。"""

    name: str = "run_terminal"
    description: str = "执行终端命令并返回输出，适合编译、语法检查、目录查看等任务。"
    parameters: dict = {
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "要执行的终端命令"},
            "timeout": {"type": "integer", "description": "超时秒数，默认 60", "minimum": 1},
            "workdir": {"type": "string", "description": "执行目录，默认项目根目录"},
        },
        "required": ["command"],
    }

    def _is_dangerous(self, command: str) -> bool:
        lower = (command or "").lower()
        dangerous_patterns = [
            "rm -rf",
            "del /f /s /q",
            "format ",
            "shutdown ",
            "reboot",
            "halt",
            "mkfs",
            "diskpart",
            "reg delete",
            "remove-item -recurse -force",
            "git reset --hard",
        ]
        return any(p in lower for p in dangerous_patterns)

    async def execute(self, command: str, timeout: int = 60, workdir: str = "") -> ToolResult:
        if not command or not command.strip():
            return ToolFailure(error="命令不能为空")

        if self._is_dangerous(command):
            return ToolFailure(error="安全拦截：命令包含高危操作")

        try:
            root = get_paths().root
            cwd = Path(workdir).resolve() if workdir else root
            if not cwd.exists():
                return ToolFailure(error=f"执行目录不存在: {cwd}")

            process = await asyncio.create_subprocess_shell(
                command,
                cwd=str(cwd),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )

            try:
                stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=max(1, int(timeout)))
            except asyncio.TimeoutError:
                process.kill()
                return ToolFailure(error=f"命令执行超时 ({timeout}s)")

            def decode_output(data: bytes) -> str:
                if not data:
                    return ""
                for enc in ("utf-8", "gb18030", "gbk"):
                    try:
                        return data.decode(enc)
                    except Exception:
                        continue
                return data.decode("utf-8", errors="ignore")

            out = decode_output(stdout).strip()
            err = decode_output(stderr).strip()
            payload = [f"工作目录: {cwd}", f"退出码: {process.returncode}"]
            if out:
                payload.append(f"标准输出:\n{out}")
            if err:
                payload.append(f"标准错误:\n{err}")
            if not out and not err:
                payload.append("命令执行完成，无输出。")

            text = "\n\n".join(payload)
            if process.returncode != 0:
                return ToolFailure(error=text)
            return ToolResult(output=text)
        except Exception as exc:
            return ToolFailure(error=f"终端执行失败: {exc}")
