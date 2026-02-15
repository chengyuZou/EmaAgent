# tools/builtin/file_ops.py
import aiofiles
from typing import Dict
from pathlib import Path
from ..base import BaseTool

from tools.base import ToolResult,ToolFailure

class FileOperationTool(BaseTool):
    """文件读写工具"""

    name: str = "file_operations"
    description: str = (
        "执行基础文件系统操作：write（写入新文件）、delete（删除文件）、list（列出目录）和read（读取文件）。"
        "⚠️ 此工具不支持分析文件内容，如需分析文件，请使用 analyze_document 工具。"
    )
    parameters: dict = {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["read", "write", "delete", "list", "current_path"],
                "description": "操作类型：read（读取）、write（写入）、delete（删除）、list（列出）, current_path（获取当前路径）"
            },
            "path": {
                "type": "string",
                "description": "文件或目录路径"
            },
            "content": {
                "type": "string",
                "description": "写入的内容（仅在operation为write时需要）"
            }
        },
        "required": ["operation", "path"]
    }

    def _smart_find(self, target_path: Path) -> Path:
        """智能查找文件：如果不存在，尝试在当前目录及子目录搜索"""
        if target_path.exists():
            return target_path
        
        # 尝试搜索同名文件
        filename = target_path.name
        # 限制搜索深度和范围，防止太慢
        root_dir = Path(".")
        
        # 1. 浅层搜索 (当前目录)
        matches = list(root_dir.glob(filename))
        if matches:
            return matches[0]
            
        # 2. 递归搜索 (2层深度)
        matches = list(root_dir.glob(f"**/{filename}"))
        if matches:
            return matches[0]
        
        # 3. 查找父级文件里是否存在该文件
        for parent in target_path.parents:
            potential_path = parent / filename
            if potential_path.exists():
                return potential_path
            
        return target_path # 没找到，返回原路径让它报错

    
    async def execute(
        self,
        operation: str,
        path: str,
        content: str = None,
        **kwargs
    ) -> ToolResult:
        """执行文件操作"""
        try:
            file_path = Path(path)

            
            if operation == "read":
                file_path = self._smart_find(file_path)
                if not file_path.exists():
                    return ToolFailure(error=f"文件不存在: {path}")
                
                if not file_path.is_file():
                    return ToolFailure(error=f"路径 {path} 不是一个文件。")
                
                async with aiofiles.open(file_path, 'r', encoding='utf-8') as f:
                    file_content = await f.read()
                
                return ToolResult(output={"content": file_content, "size": len(file_content)})
            
            elif operation == "current_path":
                return ToolResult(output={"current_path": str(Path(".").resolve())})
            
            elif operation == "write":
                if not content:
                    return ToolFailure(error="写入内容不能为空")
                
                # 创建目录
                file_path.parent.mkdir(parents=True, exist_ok=True)
                
                async with aiofiles.open(file_path, 'w', encoding='utf-8') as f:
                    await f.write(content)
                
                return ToolResult(output={"message": "文件写入成功", "path": str(file_path), "size": len(content)})

                      
            elif operation == "delete":
                if not file_path.exists():
                    return ToolFailure(error=f"文件不存在: {path}")
                
                file_path.unlink()
                
                return ToolResult(output={"message": "文件删除成功", "path": str(file_path)})
            
            # === 列出目录 ===
            elif operation == "list":
                if not file_path.exists():
                    file_path = Path(".") # 默认列出当前
                
                items = []
                for item in file_path.iterdir():
                    type_icon = "📁" if item.is_dir() else "📄"
                    items.append(f"{type_icon} {item.name}")
                
                return ToolResult(output="\n".join(items[:50])) # 限制返回数量
         
            else:
                return ToolFailure(error=f"不支持的操作类型: {operation},目前只支持read, write, list, delete")
        
        except Exception as e:
            return ToolFailure(error=f"文件操作失败: {str(e)}")
        
        