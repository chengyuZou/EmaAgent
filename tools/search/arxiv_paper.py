import re
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional
from urllib.parse import quote

import aiohttp

from ..base import BaseTool, ToolFailure, ToolResult


class ArxivPaperTool(BaseTool):
    """搜寻并阅读 arXiv 论文的工具"""

    name: str = "arxiv_paper"
    description: str = (
        "通过 arXiv API 搜索和获取论文信息"
        "提供两种操作: search(搜索论文)和 read(获取论文详情)"
    )
    parameters: dict = {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["search", "read"],
                "description": "search: 根据关键词搜索论文; read: 根据 arXiv id 或 URL 获取论文详情",
            },
            "query": {
                "type": "string",
                "description": "搜索关键词 (仅对 search 操作有效) 或可选的 id/url 回退 (仅对 read 操作有效)",
            },
            "arxiv_id": {
                "type": "string",
                "description": "arXiv id 或 URL, 例如 1706.03762 或 https://arxiv.org/abs/1706.03762",
            },
            "max_results": {
                "type": "integer",
                "description": "最大搜索结果数量 (仅对 search 操作有效，范围 1-20)",
                "default": 5,
            },
        },
        "required": ["operation"],
    }

    async def execute(
        self,
        operation: str,
        query: Optional[str] = None,
        arxiv_id: Optional[str] = None,
        max_results: int = 5,
        **kwargs,
    ) -> ToolResult:
        """
        operation: `search` 或 `read`

        Args:
            operation (str): 要执行的操作，"search" 或 "read"
            query (Optional[str]): 搜索关键词 (仅对 search 操作有效) 或可选的 id/url 回退 (仅对 read 操作有效)
            arxiv_id (Optional[str]): arXiv id 或 URL, 例如 1706.03762 或 https://arxiv.org/abs/1706.03762 (仅对 read 操作有效)
            max_results (int): 最大搜索结果数量 (仅对 search 操作有效，范围 1-20)

        Returns:
            ToolResult (ToolResult): 包含操作结果，或 ToolFailure 包含错误信息
        """

        del kwargs

        # 规范化输入参数
        op = (operation or "").strip().lower()
        # search 操作必须有 query，read 操作必须有 arxiv_id 或 query（作为 id/url 回退）
        if op == "search":
            if not query or not query.strip():
                return ToolFailure(error="当operation=search时 query参数不能为空")
            # 搜索结果数量限制在 1-20 之间，默认5
            size = max(1, min(20, int(max_results)))
            # 执行搜索
            papers = await self._search_papers(query.strip(), size)
            return ToolResult(
                output={
                    "operation": "search",
                    "query": query.strip(),
                    "count": len(papers),
                    "results": papers,
                }
            )
        
        # read 操作需要一个有效的 arXiv id，优先使用 arxiv_id 参数，如果没有则尝试从 query 参数中提取
        if op == "read":
            target = self._normalize_arxiv_id(arxiv_id or query or "")
            if not target:
                return ToolFailure(error="当operation=read时 arxiv_id参数或 query参数中必须包含有效的 arXiv id 或 URL")
            # 执行获取论文详情
            paper = await self._read_paper(target)
            if not paper:
                return ToolFailure(error=f"无法获取论文详情: {target}")
            return ToolResult(output={"operation": "read", "paper": paper})

        return ToolFailure(error=f"未支持的操作: {operation} 仅支持 search 和 read")

    async def _search_papers(self, query: str, max_results: int) -> List[Dict[str, Any]]:
        """
        使用 arXiv API 搜索论文

        Args:
            query (str): 搜索关键词
            max_results (int): 最大搜索结果数量

        Returns:
            papers (List[Dict[str, Any]]): 论文列表，每个论文包含 arxiv_id, title, authors, published, updated, url, pdf_url, abstract 等信息
        """
        # 构建 arXiv API 查询 URL
        feed_url = (
            "http://export.arxiv.org/api/query?"
            f"search_query=all:{quote(query)}&start=0&max_results={max_results}"
            "&sortBy=relevance&sortOrder=descending"
        )
        # 获取并解析 XML 响应
        xml_text = await self._fetch_feed(feed_url)
        if not xml_text:
            return []
        
        # 解析论文条目并返回结果，附加排名信息
        papers = self._parse_entries(xml_text)
        for idx, paper in enumerate(papers):
            paper["rank"] = idx + 1
        return papers

    async def _read_paper(self, arxiv_id: str) -> Optional[Dict[str, Any]]:
        """
        根据 arXiv id 获取论文详情

        Args:
            arxiv_id (str): arXiv id 例如 1706.03762

        Returns:
            paper (Optional[Dict[str, Any]]): 论文详情，包含 arxiv_id, title, authors, published, updated, url, pdf_url, abstract 等信息，如果获取失败
        """
        # 构建 arXiv API 查询 URL，使用 id_list 参数直接查询特定论文
        feed_url = f"http://export.arxiv.org/api/query?id_list={quote(arxiv_id)}"
        xml_text = await self._fetch_feed(feed_url)
        if not xml_text:
            return None
        # 解析论文条目并返回第一个结果（应该只有一个），如果没有找到则返回 None
        papers = self._parse_entries(xml_text)
        if not papers:
            return None
        return papers[0]

    async def _fetch_feed(self, url: str) -> Optional[str]:
        """
        使用 aiohttp 获取 arXiv API 的 XML 响应文本

        Args:
            url (str): arXiv API 查询 URL

        Returns:
            xml_text (Optional[str]): XML 响应文本，如果请求失败或响应无效则返回 None
        """
        # 设置 User-Agent 和 Accept 头，增加超时设置，处理请求异常
        headers = {
            "User-Agent": "EmaAgent/0.2 (+https://arxiv.org)",
            "Accept": "application/atom+xml,text/xml;q=0.9,*/*;q=0.8",
        }
        timeout = aiohttp.ClientTimeout(total=20)
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(url, headers=headers) as resp:
                    if resp.status != 200:
                        return None
                    return await resp.text()
        except Exception:
            return None

    def _parse_entries(self, xml_text: str) -> List[Dict[str, Any]]:
        """
        解析 arXiv API 返回的 Atom XML 提取论文信息

        Args:
            xml_text (str): arXiv API 返回的 Atom XML 文本

        Returns:
            entries (List[Dict[str, Any]]): 论文信息列表，每个包含 arxiv_id, title, authors, published, updated, url, pdf_url, abstract 等字段
        """
        # 定义 XML 命名空间，解析 XML 并提取论文条目信息，处理解析异常
        ns = {"atom": "http://www.w3.org/2005/Atom"}
        try:
            # 解析 XML 文本，如果格式不正确会抛出 ParseError 异常
            root = ET.fromstring(xml_text)
        except ET.ParseError:
            return []
        
        # 遍历所有 entry 元素，提取论文信息并构建结果列表
        entries: List[Dict[str, Any]] = []
        for entry in root.findall("atom:entry", ns):
            raw_id = self._safe_find_text(entry, "atom:id", ns)
            paper_id = raw_id.rsplit("/", 1)[-1] if raw_id else ""
            title = self._clean_whitespace(self._safe_find_text(entry, "atom:title", ns))
            abstract = self._clean_whitespace(self._safe_find_text(entry, "atom:summary", ns))
            published = self._safe_find_text(entry, "atom:published", ns)[:10]
            updated = self._safe_find_text(entry, "atom:updated", ns)[:10]

            # 提取作者列表，处理可能的空值和多余空白
            authors: List[str] = []
            for a in entry.findall("atom:author", ns):
                name = self._clean_whitespace(self._safe_find_text(a, "atom:name", ns))
                if name:
                    authors.append(name)

            # 提取 PDF 链接，优先使用 link 元素中的 pdf 类型链接，如果没有则尝试从 id URL 构造
            pdf_url = ""
            for link in entry.findall("atom:link", ns):
                href = link.attrib.get("href", "")
                link_title = link.attrib.get("title", "")
                link_type = link.attrib.get("type", "")
                if link_title == "pdf" or link_type == "application/pdf":
                    pdf_url = href
                    break

            # 如果没有找到 PDF 链接但有 id URL，尝试从 id URL 构造 PDF 链接（将 /abs/ 替换为 /pdf/ 并添加 .pdf 后缀）
            if not pdf_url and raw_id and "/abs/" in raw_id:
                pdf_url = raw_id.replace("/abs/", "/pdf/") + ".pdf"

            # 构建论文信息字典并添加到结果列表中，确保所有字段都有合理的默认值
            entries.append(
                {
                    "arxiv_id": paper_id,
                    "title": title,
                    "authors": authors,
                    "published": published,
                    "updated": updated,
                    "url": raw_id,
                    "pdf_url": pdf_url,
                    "abstract": abstract,
                }
            )

        return entries

    def _normalize_arxiv_id(self, raw: str) -> Optional[str]:
        """
        从输入文本中提取和规范化 arXiv id
        Args:
            raw (str): 输入文本，可能是 arXiv id 或 URL
        Returns:
            arxiv_id (Optional[str]): 规范化的 arXiv id 例如 1706.03762 如果无法提取则返回 None
        """
        text = (raw or "").strip()
        if not text:
            return None

        m = re.search(r"arxiv\.org/(?:abs|pdf)/([^?#]+)", text, flags=re.IGNORECASE)
        if m:
            text = m.group(1)
        text = text.replace(".pdf", "").replace("arXiv:", "").strip()
        return text or None

    @staticmethod
    def _safe_find_text(node: ET.Element, path: str, ns: Dict[str, str]) -> str:
        """
        安全地查找 XML 元素文本，避免 None 引发的异常
        Args:
            node (ET.Element): XML 元素节点
            path (str): 子元素路径
            ns (Dict[str, str]): XML 命名空间映射
        Returns:
            text (str): 查找到的文本内容，去除多余空白，如果未找到或文本为空则返回空字符串
        """
        child = node.find(path, ns)
        return child.text.strip() if child is not None and child.text else ""

    @staticmethod
    def _clean_whitespace(text: str) -> str:
        """
        清理文本中的多余空白字符，将连续的空白替换为单个空格，并去除首尾空白
        Args:
            text (str): 输入文本
        Returns:
            cleaned (str): 清理后的文本
        """
        return " ".join((text or "").split())

