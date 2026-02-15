import asyncio
import subprocess
import sys
from pathlib import Path

from config.paths import get_paths
from tools.base import ToolFailure, ToolResult

from ..base import BaseTool


class CodeExecutorTool(BaseTool):
    """执行 Python 代码片段。"""

    name: str = "execute_code"
    description: str = "运行 Python 代码，适合语法检查、计算和文件读取后的分析。"
    parameters: dict = {
        "type": "object",
        "properties": {
            "code": {"type": "string", "description": "要执行的 Python 代码"},
            "timeout": {"type": "integer", "description": "超时秒数，默认 20", "minimum": 1},
            "workdir": {"type": "string", "description": "执行目录，默认项目根目录"},
        },
        "required": ["code"],
    }

    async def execute(self, code: str, timeout: int = 20, workdir: str = "") -> ToolResult:
        if not code or not code.strip():
            return ToolFailure(error="代码不能为空")

        dangerous = [
            "os.system(",
            "shutil.rmtree(",
            "input(",
            "subprocess.Popen(",
            "subprocess.run(",
            "subprocess.call(",
        ]
        for word in dangerous:
            if word in code:
                return ToolFailure(error=f"安全拦截：代码包含禁止关键词 '{word}'")

        try:
            root = get_paths().root
            cwd = Path(workdir).resolve() if workdir else root
            if not cwd.exists():
                return ToolFailure(error=f"执行目录不存在: {cwd}")

            process = await asyncio.create_subprocess_exec(
                sys.executable,
                "-u",
                "-c",
                code,
                cwd=str(cwd),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )

            try:
                stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=max(1, int(timeout)))
            except asyncio.TimeoutError:
                process.kill()
                return ToolFailure(error=f"代码执行超时 ({timeout}s)")

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

            if process.returncode != 0:
                error_text = err or out or "无错误输出"
                return ToolFailure(error=f"执行失败（退出码 {process.returncode}）\n{error_text}")

            parts = [f"执行目录: {cwd}", f"退出码: {process.returncode}"]
            if out:
                parts.append(f"标准输出:\n{out}")
            if err:
                parts.append(f"标准错误:\n{err}")
            if not out and not err:
                parts.append("代码执行成功，但没有输出。")

            return ToolResult(output="\n\n".join(parts))
        except Exception as exc:
            return ToolFailure(error=f"执行器内部错误: {exc}")
