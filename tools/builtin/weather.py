# tools/builtin/weather.py
import aiohttp
from ..base import BaseTool
from typing import Dict

from tools.base import ToolResult,ToolFailure

class WeatherTool(BaseTool):
    """天气查询工具"""

    name: str = "get_weather"
    description: str = "查询指定城市的天气信息"
    parameters: dict = {
        "type": "object",
        "properties": {
            "city": {
                "type": "string",
                "description": "城市名称，如'北京'"
            }
        },
        "required": ["city"]
    }

    
    async def execute(self, city: str, days: int = 1, **kwargs) -> Dict:
        """执行天气查询"""
        try:
            # 使用免费的天气API - wttr.in
            url = f"http://wttr.in/{city}?format=j1"

            async with aiohttp.ClientSession() as session:
                async with session.get(url) as resp:
                    if resp.status != 200:
                        return ToolFailure(error=f"HTTP Error: {resp.status}")
                    
                    data = await resp.json()

                    # 简化返回数据
                    current_condition = data["current_condition"][0]
                    result = {
                        "city": data["nearest_area"][0]["areaName"][0]["value"],
                        "current": {
                            "temp_c": current_condition["temp_C"],
                            "condition": current_condition["weatherDesc"][0]["value"],
                            "humidity": current_condition["humidity"],
                            "feels_like": current_condition["FeelsLikeC"]
                        }
                    }

                    # 如果需要未来几天的天气预报
                    if days > 1 and "weather" in data:
                        forecasts = []
                        for i in range(min(days-1, len(data["weather"]))):
                            day_data = data["weather"][i]
                            forecasts.append({
                                "date": day_data["date"],
                                "max_temp": day_data["maxtempC"],
                                "min_temp": day_data["mintempC"],
                                "condition": day_data["hourly"][0]["weatherDesc"][0]["value"]
                            })
                        result["forecast"] = forecasts

                return ToolResult(output=result)
                
        except Exception as e:
            return ToolFailure(error=f"天气查询失败: {str(e)}")  
