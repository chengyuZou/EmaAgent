import aiohttp
from bs4 import BeautifulSoup
from typing import Dict, Any
from .base import BaseTool, ToolResult, ToolFailure

class WebScraperTool(BaseTool):
    """网页内容抓取工具"""
    
    name: str = "read_webpage"
    description: str = "读取指定URL的网页详细内容。当搜索结果的摘要不足以回答问题时使用。"
    parameters: dict = {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "需要读取的网页链接(URL)"
            }
        },
        "required": ["url"]
    }

    async def execute(self, url: str) -> ToolResult:
        try:
            # 伪装 User-Agent 防止被反爬
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
            }
            
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers, timeout=10) as response:
                    if response.status != 200:
                        return ToolFailure(error=f"网页访问失败，状态码: {response.status}")
                    
                    html = await response.text()
            
            # 解析 HTML
            soup = BeautifulSoup(html, 'html.parser')
            
            # 移除脚本和样式
            for script in soup(["script", "style", "nav", "footer", "iframe"]):
                script.decompose()
                
            # 提取主要文本
            text = soup.get_text(separator="\n")
            
            # 清洗空行
            lines = [line.strip() for line in text.splitlines() if line.strip()]
            clean_text = "\n".join(lines)
            
            # 截断过长内容 (防止 Token 爆炸)
            max_len = 3000
            if len(clean_text) > max_len:
                clean_text = clean_text[:max_len] + "\n...(内容过长已截断)"
                
            metadata = {
                "title": soup.title.string if soup.title else "无标题",
                "url": url,
                "length": len(clean_text)
            }
            
            return ToolResult(output=clean_text, system=str(metadata))

        except Exception as e:
            return ToolFailure(error=f"网页读取出错: {str(e)}")
