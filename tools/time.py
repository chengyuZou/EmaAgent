from datetime import datetime
from .base import BaseTool, ToolResult

class TimeTool(BaseTool):
    """系统时间查询工具"""
    
    name: str = "get_current_time"
    description: str = "获取当前的系统日期、时间、星期几。回答关于'今天'、'日期'、'时间'的问题时必须调用。"
    parameters: dict = {
        "type": "object",
        "properties": {},
        "required": []
    }

    async def execute(self) -> ToolResult:
        now = datetime.now()
        weekdays = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]
        
        time_info = {
            "iso_format": now.isoformat(),
            "date": now.strftime("%Y年%m月%d日"),
            "time": now.strftime("%H:%M:%S"),
            "weekday": weekdays[now.weekday()],
            "timestamp": now.timestamp()
        }
        
        # 构造自然语言输出，方便 LLM 理解
        output_text = f"当前时间: {time_info['date']} {time_info['weekday']} {time_info['time']}"
        
        return ToolResult(output=output_text)