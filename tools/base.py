import json
from abc import ABC, abstractmethod
from typing import Any, Dict, Optional, Union, Dict, List

from pydantic import BaseModel, Field, field_validator

class ToolResult(BaseModel):
    """工具结果定义"""

    output: str = Field(default="")  
    error: Optional[str] = Field(default=None)
    base64_image: Optional[str] = Field(default=None)
    system: Optional[str] = Field(default=None)


    @field_validator('output', mode='before')
    @classmethod
    def ensure_string_output(cls, v: Any) -> str:
        """确保 output 总是字符串"""
        if v is None:
            return ""
        if isinstance(v, str):
            return v
        if isinstance(v, (dict, list)):
            return json.dumps(v, ensure_ascii=False, indent=2)
        return str(v)

    def __add__(self, other: "ToolResult") -> "ToolResult":
        """合并两个结果"""
        def combine_fields(
            field: Optional[str], other_field: Optional[str], concatenate: bool = True
        ):
            if field and other_field:
                if concatenate:
                    return field + other_field
                raise ValueError("无法合并工具结果")
            return field or other_field
        # 返回合并结果
        return ToolResult(
            output=combine_fields(self.output, other.output),
            error=combine_fields(self.error, other.error),
            base64_image=combine_fields(self.base64_image, other.base64_image, False),
            system=combine_fields(self.system, other.system),
        )
    
    def __str__(self) -> str:
        return f"Error: {self.error}" if self.error else f"Output: {self.output}"
    
    def to_dict(self) -> Dict[str, Optional[str]]:
        """转换为字典格式, 要严格判断output类型"""
        return {
            "output": self.output,
            "error": self.error,
            "base64_image": self.base64_image,
            "system": self.system,
        }
    
class BaseTool(ABC, BaseModel):
    """工具基类定义"""

    name: str
    description: str
    parameters: Optional[Dict] = None

    async def __call__(self, **kwargs) -> ToolResult:
        """执行工具"""
        return await self.execute(**kwargs)
    
    @abstractmethod
    async def execute(self, **kwargs) -> Any:
        """Execute the tool with given parameters."""

    def to_param(self) -> Dict[str, Any]:
        """Convert tool to function call format.

        Returns:
            Dictionary with tool metadata in OpenAI function calling format
        """
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }

    def success_response(self, data: Union[Dict[str, Any], str, Any]) -> ToolResult:
        """Create a successful tool result - 自动转换为字符串"""
        return ToolResult(output=data)  # Pydantic 会自动调用 validator

    def fail_response(self, msg: str) -> ToolResult:
        """Create a failed tool result"""
        return ToolResult(error=msg, output="")


class CLIResult(ToolResult):
    """A ToolResult that can be rendered as a CLI output."""


class ToolFailure(ToolResult):
    """A ToolResult that represents a failure."""