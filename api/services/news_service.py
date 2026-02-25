"""
新闻聚合服务模块

该模块负责多来源抓取 结果清洗 偏好加权 结果去重 与缓存
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import random
import re
from datetime import datetime, timedelta
from threading import Lock
from typing import Dict, List, Optional, Sequence, Set, Tuple

import httpx
from bs4 import BeautifulSoup

DEFAULT_QUERY = "魔法少女的魔女审判"

# 爬取内容上限控制在 50-200 之间 避免过度抓取
MIN_LIMIT = 50
MAX_LIMIT = 200

CHARACTERS = {
    "Ema": {"cn": "樱羽艾玛", "jp": "桜羽エマ", "short": ["艾玛", "エマ"]},
    "Hiro": {"cn": "二阶堂希罗", "jp": "二隠堂ヒロ", "short": ["希罗", "ヒロ"]},
    "Meruru": {"cn": "冰上梅露露", "jp": "水上メルル", "short": ["梅露露", "メルル"]},
    "Milia": {"cn": "佐伯米莉亚", "jp": "佐伯ミリア", "short": ["米莉亚", "ミリア"]},
    "Hanna": {"cn": "远野汉娜", "jp": "遠野ハンナ", "short": ["汉娜", "ハンナ"]},
    "Coco": {"cn": "泽度可可", "jp": "セソトココ", "short": ["可可", "ココ"]},
    "Margo": {"cn": "宝生玛格", "jp": "宝生マルコ", "short": ["玛格", "マルコ"]},
    "Sherry": {"cn": "橘雪莉", "jp": "橘シェリー", "short": ["雪莉", "シェリー"]},
    "Leia": {"cn": "莲见蕾雅", "jp": "蓮見レイア", "short": ["蕾雅", "レイア"]},
    "AnAn": {"cn": "夏目安安", "jp": "夏目アンアン", "short": ["安安", "アンアン"]},
    "Noah": {"cn": "城崎诺亚", "jp": "城崎ノア", "short": ["诺亚", "ノア"]},
    "Nanoka": {"cn": "黑部奈叶香", "jp": "黒部ナノカ", "short": ["奈叶香", "ナノカ"]},
    "Alisa": {"cn": "紫藤亚里沙", "jp": "紫藤アリサ", "short": ["亚里沙", "アリサ"]},
    "Yuki": {"cn": "月代雪", "jp": "月代ユキ", "short": ["月代雪", "ユキ"]},
    "Warden": {"cn": "典狱长", "jp": "典獄長", "short": ["典狱长"]},
    "Jailer": {"cn": "看守", "jp": "看守", "short": ["看守"]},
}

# 剩下两个暂时不打算启用
CATEGORY_RULES = [
    {"category": "official", "keywords": ["官方", "公式", "PV", "Acacia", "配信", "发售", "更新", "公告"]},
    {"category": "gameplay", "keywords": ["实况", "流程", "攻略", "通关", "全流程", "游玩", "试玩", "剧情", "录像"]},
    {"category": "fan_art", "keywords": ["二创", "同人", "手书", "MAD", "插画", "绘画", "画", "イラスト"]},
    {"category": "discussion", "keywords": ["考察", "分析", "解说", "讨论", "评测", "review", "感想", "盘点"]},
    {"category": "music", "keywords": ["BGM", "OST", "音乐", "歌", "曲", "翻唱"]},
    {"category": "cosplay", "keywords": ["cos", "cosplay", "コスプレ"]},
]

CATEGORY_LABELS = {
    "official": "🔶 官方资讯",
    "gameplay": "🎮 游戏实况",
    "fan_art": "🎨 同人二创",
    "discussion": "💬 讨论考察",
    "music": "🎵 音乐相关",
    "cosplay": "🕺 Cosplay",
    "other": "📰 其他",
}


class NewsService:
    """
    新闻聚合服务类

    该类提供 B 站 百度 Google 抓取能力
    并包含重试 缓存 偏好词加权 与统一数据结构输出
    """

    COMMON_HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }

    def __init__(self):
        """
        初始化新闻服务缓存
        """
        # 缓存结构 key 为参数哈希 value 为(结果 时间戳)
        self._cache: Dict[str, Tuple[List[Dict], datetime]] = {}
        # 线程锁用于保护缓存读写一致性
        self._cache_lock = Lock()
        # 缓存时效默认 10 分钟
        self._cache_ttl = timedelta(minutes=10)

    async def fetch_news(
        self,
        source: str = "bilibili",
        query: Optional[str] = None,
        limit: int = 100,
        page: int = 1,
        preferred_sources: Optional[List[str]] = None,
        preferred_characters: Optional[List[str]] = None,
    ) -> List[Dict]:
        """
        获取新闻列表主入口

        该方法负责参数归一化 缓存命中检查 偏好抓取 合并排序 与结果缓存

        Args:
            source (str): 数据源名称 支持 bilibili baidu google
            query (Optional[str]): 用户查询文本
            limit (int): 结果上限
            page (int): 页码 从 1 开始
            preferred_sources (Optional[List[str]]): 来源偏好列表
            preferred_characters (Optional[List[str]]): 角色偏好列表

        Returns:
            List[Dict]: 统一结构新闻列表

        Examples:
            >>> rows = await svc.fetch_news(source="bilibili", query="魔裁")
            >>> # rows is list of dict
            pass
        """

        # 归一化基础查询参数
        source = (source or "bilibili").lower()
        page = max(page, 1)
        limit = max(MIN_LIMIT, min(MAX_LIMIT, int(limit)))
        base_search_query = self._compose_search_query(query)

        # 归一化来源偏好列表
        pref_sources = self._normalize_list(preferred_sources)
        # 归一化角色偏好列表
        pref_chars = self._normalize_list(preferred_characters)

        # 兼容 source=all 或 source=auto 场景
        # 当给出来源偏好时优先使用偏好中的首个来源
        if source in ("all", "auto") and pref_sources:
            source = pref_sources[0].lower()

        # 构建缓存键并查看命中缓存
        cache_key = self._build_cache_key(source, base_search_query, limit, page, pref_chars + pref_sources)
        with self._cache_lock:
            cached = self._cache.get(cache_key)
            # 缓存命中且未过期时直接返回缓存结果 避免重复抓取
            if cached:
                payload, ts = cached
                if datetime.now() - ts < self._cache_ttl:
                    return payload

        # 根据偏好角色构建偏好词列表
        preference_terms = self._build_preference_terms(pref_chars)
        # 偏好模式下使用 7 比 3 分配偏好与基础配额
        if preference_terms:
            pref_limit = int(round(limit * 0.7))
            base_limit = max(limit - pref_limit, 0)
        else:
            pref_limit = 0
            base_limit = limit

        # 先抓取基础结果
        base_items = await self._fetch_by_source(
            source=source,
            search_query=base_search_query,
            limit=max(base_limit, 1 if pref_limit == 0 else 0),
            page=page,
            is_preference=False,
        )

        # 再抓取偏好结果
        pref_items: List[Dict] = []
        if pref_limit > 0 and preference_terms:
            pref_items = await self._fetch_preference_items(
                source, base_search_query, preference_terms, pref_limit, page
            )

        # 合并并按偏好打分排序
        merged = self._merge_with_ratio(base_items, pref_items, base_limit, pref_limit, limit)
        scored = self._sort_with_preference_score(merged, preference_terms)

        # 写入缓存 供短期重复请求复用
        with self._cache_lock:
            self._cache[cache_key] = (scored, datetime.now())

        return scored[:limit]

    async def _fetch_preference_items(
        self,
        source: str,
        base_search_query: str,
        preference_terms: Sequence[str],
        total_limit: int,
        page: int,
    ) -> List[Dict]:
        """
        按偏好词并发抓取结果

        Args:
            source (str): 数据源名称
            base_search_query (str): 基础查询词
            preference_terms (Sequence[str]): 偏好词列表
            total_limit (int): 总偏好结果上限
            page (int): 页码

        Returns:
            List[Dict]: 偏好结果列表 已去重

        Examples:
            >>> # rows = await svc._fetch_preference_items("bilibili" "魔裁" ["艾玛"] 20 1)
            >>> # rows is list
            pass
        """
        # 按偏好词均分抓取配额
        per_term = max(1, math.ceil(total_limit / max(len(preference_terms), 1)))
        # 控制并发数 避免请求过密
        sem = asyncio.Semaphore(3)

        async def _task(term: str) -> List[Dict]:
            async with sem:
                # 每个偏好词构造独立查询
                q = f"{base_search_query} {term}".strip()
                return await self._fetch_by_source(
                    source=source,
                    search_query=q,
                    limit=per_term,
                    page=page,
                    is_preference=True,
                )

        # 并发执行全部偏好词任务
        tasks = [_task(term) for term in preference_terms]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # 合并任务结果并去重
        merged: List[Dict] = []
        seen: Set[str] = set()
        for result in results:
            if isinstance(result, Exception):
                continue
            for item in result:
                uid = self._item_unique_id(item)
                if uid in seen:
                    continue
                seen.add(uid)
                merged.append(item)
        return merged[:total_limit]

    async def _fetch_by_source(
        self,
        source: str,
        search_query: str,
        limit: int,
        page: int,
        is_preference: bool,
    ) -> List[Dict]:
        """
        按来源分发抓取逻辑

        Args:
            source (str): 数据源名称
            search_query (str): 查询词
            limit (int): 结果上限
            page (int): 页码
            is_preference (bool): 是否为偏好抓取结果

        Returns:
            List[Dict]: 统一结构结果列表

        Examples:
            >>> # rows = await svc._fetch_by_source("baidu", "魔裁", 50, 1, False)
        """
        # 非法上限直接返回空
        if limit <= 0:
            return []

        # 根据来源调用对应抓取函数
        if source == "bilibili":
            items = await self._fetch_bilibili(search_query, limit, page)
        elif source == "baidu":
            items = await self._fetch_baidu(search_query, limit, page)
        elif source == "google":
            items = await self._fetch_google(search_query, limit)
        else:
            items = []

        # 标注是否命中偏好检索
        for item in items:
            item["is_preference_hit"] = is_preference
        return items

    async def _fetch_bilibili(self, search_query: str, limit: int, page: int = 1) -> List[Dict]:
        """
        抓取 B 站搜索结果

        Args:
            search_query (str): 查询词
            limit (int): 结果上限
            page (int): 起始页码

        Returns:
            List[Dict]: B 站结果列表

        Examples:
            >>> # rows = await svc._fetch_bilibili("魔裁", 100, 1)
        """
        # 设定单页大小并估算页数 上限 5 页
        page_size = 50
        pages_needed = min(max(math.ceil(limit / page_size), 1), 5)
        page_numbers = list(range(page, page + pages_needed))

        # 限制并发以降低封禁风险
        sem = asyncio.Semaphore(3)

        async def _search_page(p: int) -> List[Dict]:
            async with sem:
                return await self._bilibili_search_page(search_query, p, page_size)

        # 并发请求多个页码
        results = await asyncio.gather(*[_search_page(p) for p in page_numbers], return_exceptions=True)

        # 跨页按 bvid 去重合并
        merged: List[Dict] = []
        seen_bvid: Set[str] = set()
        for result in results:
            if isinstance(result, Exception):
                continue
            for item in result:
                bvid = item.get("bvid") or ""
                key = bvid or self._item_unique_id(item)
                if key in seen_bvid:
                    continue
                seen_bvid.add(key)
                merged.append(item)

        return merged[:limit]

    async def _bilibili_search_page(self, search_query: str, page: int, page_size: int) -> List[Dict]:
        """
        调用 B 站主搜索接口并解析

        Args:
            search_query (str): 查询词
            page (int): 页码
            page_size (int): 页大小

        Returns:
            List[Dict]: 解析后的结果列表

        Examples:
            >>> # rows = await svc._bilibili_search_page("魔裁", 1, 50)
        """
        # 主搜索接口
        url = "https://api.bilibili.com/x/web-interface/search/type"
        params = {
            "search_type": "video",
            "keyword": search_query,
            "page": page,
            "page_size": page_size,
            "order": "totalrank",
        }
        headers = {
            **self.COMMON_HEADERS,
            "Origin": "https://search.bilibili.com",
            "Referer": "https://search.bilibili.com/",
        }

        # 请求主接口 失败则走兜底接口
        data = await self._request_json_with_retry(url, params=params, headers=headers, retries=4)
        if not data or data.get("code") != 0:
            # 主接口异常时回退到 all/v2
            fallback = await self._bilibili_search_page_fallback(search_query, page)
            return fallback

        # 读取结果数组并转换为统一字段
        result_list = data.get("data", {}).get("result", []) or []
        parsed = [self._normalize_bilibili_item(item, search_query) for item in result_list]
        # 过滤规范化失败的空项
        return [x for x in parsed if x]

    async def _bilibili_search_page_fallback(self, search_query: str, page: int) -> List[Dict]:
        """
        调用 B 站兜底搜索接口

        Args:
            search_query (str): 查询词
            page (int): 页码

        Returns:
            List[Dict]: 解析后的结果列表

        Examples:
            >>> # rows = await svc._bilibili_search_page_fallback("魔裁", 1)
        """
        # 兜底接口
        url = "https://api.bilibili.com/x/web-interface/search/all/v2"
        params = {
            "keyword": search_query,
            "page": page,
        }
        headers = {
            **self.COMMON_HEADERS,
            "Origin": "https://search.bilibili.com",
            "Referer": "https://search.bilibili.com/",
        }

        data = await self._request_json_with_retry(url, params=params, headers=headers, retries=3)
        if not data or data.get("code") != 0:
            return []

        # all/v2 接口返回分组列表 需要抽取 video 分组
        result_blocks = data.get("data", {}).get("result", []) or []
        video_block = None
        for block in result_blocks:
            if block.get("result_type") == "video":
                video_block = block
                break
        if not video_block:
            return []

        # 将 video 分组数据映射为标准条目
        result_list = video_block.get("data", []) or []
        parsed = [self._normalize_bilibili_item(item, search_query) for item in result_list]
        return [x for x in parsed if x]

    async def _fetch_baidu(self, search_query: str, limit: int, page: int = 1) -> List[Dict]:
        """
        抓取百度搜索结果

        Args:
            search_query (str): 查询词
            limit (int): 结果上限
            page (int): 起始页码

        Returns:
            List[Dict]: 百度结果列表

        Examples:
            >>> # rows = await svc._fetch_baidu("魔裁", 50, 1)
            >>> # rows is list
            pass
        """
        # 百度每页数量
        rn = 20
        # 最多抓取 6 页 控制上游压力
        pages_needed = min(max(math.ceil(limit / rn), 1), 6)
        # 百度分页参数按偏移量递增
        pns = [max(page - 1, 0) * rn + i * rn for i in range(pages_needed)]

        # 控制并发避免请求过密
        sem = asyncio.Semaphore(3)

        async def _search_page(pn: int) -> List[Dict]:
            async with sem:
                # 单页请求复用统一解析逻辑
                return await self._baidu_search_page(search_query, pn, rn)

        results = await asyncio.gather(*[_search_page(pn) for pn in pns], return_exceptions=True)

        merged: List[Dict] = []
        seen: Set[str] = set()
        for result in results:
            if isinstance(result, Exception):
                # 单页异常时忽略 保留其他页结果
                continue
            for item in result:
                # 使用统一唯一键去重
                key = self._item_unique_id(item)
                if key in seen:
                    continue
                seen.add(key)
                merged.append(item)

        return merged[:limit]

    async def _baidu_search_page(self, search_query: str, pn: int, rn: int) -> List[Dict]:
        """
        抓取百度单页并解析 HTML

        Args:
            search_query (str): 查询词
            pn (int): 偏移参数
            rn (int): 单页条数

        Returns:
            List[Dict]: 单页解析结果

        Examples:
            >>> # rows = await svc._baidu_search_page("魔裁" 0 20)
            >>> # rows is list
            pass
        """
        # 百度网页搜索入口
        url = "https://www.baidu.com/s"
        params = {"wd": search_query, "pn": pn, "rn": rn}

        html = await self._request_text_with_retry(url, params=params, headers=self.COMMON_HEADERS, retries=3)
        if not html:
            return []

        # 使用 html 解析器提取候选结果节点
        soup = BeautifulSoup(html, "html.parser")
        candidates = soup.select(".result, .result-op, .c-container")

        result: List[Dict] = []
        for item in candidates:
            # 尝试多种标题选择器兼容不同模板
            title_el = item.select_one("h3 a, .t a, .c-title a")
            if not title_el:
                continue

            # 清洗标题与跳转链接
            title = title_el.get_text(" ", strip=True)
            link = (title_el.get("href") or "").strip()
            if not title or not link:
                continue

            # 描述字段在不同模版的 class 不同
            desc_el = item.select_one(".content-right_2s-H4, .c-abstract, .c-span-last")
            desc = desc_el.get_text(" ", strip=True) if desc_el else ""

            # 构造统一条目结构 便于前端统一渲染
            result.append(
                {
                    "id": f"baidu_{hashlib.md5(link.encode('utf-8')).hexdigest()[:12]}",
                    "title": title,
                    "url": link,
                    "source": "baidu",
                    "source_label": "百度",
                    "thumbnail": "",
                    "date": "",
                    "author": "",
                    "description": desc[:220],
                    "play_count": 0,
                    "danmaku_count": 0,
                    "duration": "",
                    "bvid": "",
                    "search_keyword": search_query,
                    "category": "other",
                    "category_label": CATEGORY_LABELS["other"],
                    "character": "",
                    "character_name": "",
                }
            )
        return result

    async def _fetch_google(self, search_query: str, limit: int) -> List[Dict]:
        """
        抓取 Google News RSS 结果

        Args:
            search_query (str): 查询词
            limit (int): 结果上限

        Returns:
            List[Dict]: Google 结果列表

        Examples:
            >>> # rows = await svc._fetch_google("魔裁", 30)
            >>> # rows is list
            pass
        """
        # RSS 检索地址
        url = "https://news.google.com/rss/search"
        params = {
            "q": search_query,
            "hl": "zh-CN",
            "gl": "CN",
            "ceid": "CN:zh-Hans",
        }

        xml_text = await self._request_text_with_retry(url, params=params, headers=self.COMMON_HEADERS, retries=3)
        if not xml_text:
            return []

        # 解析 RSS xml 并获取 item 节点
        soup = BeautifulSoup(xml_text, "xml")
        items = soup.find_all("item")

        result: List[Dict] = []
        seen: Set[str] = set()
        for item in items:
            # 读取标题与链接作为核心字段
            title = item.title.text.strip() if item.title and item.title.text else ""
            link = item.link.text.strip() if item.link and item.link.text else ""
            if not title or not link:
                continue
            if link in seen:
                continue
            seen.add(link)

            # 发布日期统一转换为 yyyy-mm-dd
            date_str = ""
            if item.pubDate and item.pubDate.text:
                date_str = self._parse_pub_date(item.pubDate.text)

            # 读取来源与描述 用于展示与偏好排序
            author = item.source.text.strip() if item.source and item.source.text else ""
            desc = item.description.text.strip() if item.description and item.description.text else ""

            # 映射为统一字段结构
            result.append(
                {
                    "id": f"google_{hashlib.md5(link.encode('utf-8')).hexdigest()[:12]}",
                    "title": title,
                    "url": link,
                    "source": "google",
                    "source_label": "Google",
                    "thumbnail": "",
                    "date": date_str,
                    "author": author,
                    "description": desc[:220],
                    "play_count": 0,
                    "danmaku_count": 0,
                    "duration": "",
                    "bvid": "",
                    "search_keyword": search_query,
                    "category": "other",
                    "category_label": CATEGORY_LABELS["other"],
                    "character": "",
                    "character_name": "",
                }
            )

            if len(result) >= limit:
                # 到达上限后提前停止遍历
                break

        return result[:limit]

    async def _request_json_with_retry(
        self,
        url: str,
        params: Optional[Dict] = None,
        headers: Optional[Dict] = None,
        retries: int = 3,
    ) -> Optional[Dict]:
        """
        带重试获取 JSON 响应

        Args:
            url (str): 请求地址
            params (Optional[Dict]): 查询参数
            headers (Optional[Dict]): 请求头
            retries (int): 最大重试次数

        Returns:
            Optional[Dict]: JSON 字典 失败返回 None

        Examples:
            >>> # data = await svc._request_json_with_retry("https://api")
            >>> # data is dict or None
            pass
        """
        # 指数退避重试
        for attempt in range(1, retries + 1):
            try:
                # 每次重试创建新 client 避免连接状态污染
                async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
                    resp = await client.get(url, params=params, headers=headers)

                if resp.status_code in (412, 429):
                    # 触发频控时增加等待时间后重试
                    await asyncio.sleep((2 ** (attempt - 1)) + random.random())
                    continue

                if resp.status_code >= 500:
                    # 服务端错误采用指数退避
                    await asyncio.sleep((2 ** (attempt - 1)) + random.random() * 0.5)
                    continue

                if resp.status_code != 200:
                    # 非 200 且非可重试状态直接返回失败
                    return None

                # 正常状态返回 json 结果
                return resp.json()
            except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError):
                if attempt == retries:
                    return None
                # 网络抖动时继续重试
                await asyncio.sleep((2 ** (attempt - 1)) + random.random() * 0.5)
            except Exception:
                # 非预期异常不重试 直接失败
                return None
        return None

    async def _request_text_with_retry(
        self,
        url: str,
        params: Optional[Dict] = None,
        headers: Optional[Dict] = None,
        retries: int = 3,
    ) -> Optional[str]:
        """
        带重试获取文本响应

        Args:
            url (str): 请求地址
            params (Optional[Dict]): 查询参数
            headers (Optional[Dict]): 请求头
            retries (int): 最大重试次数

        Returns:
            Optional[str]: 文本内容 失败返回 None

        Examples:
            >>> # text = await svc._request_text_with_retry("https://www.example.com")
            >>> # text is str or None
            pass
        """
        # 指数退避重试
        for attempt in range(1, retries + 1):
            try:
                # 每次重试创建新 client 保持请求隔离
                async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
                    resp = await client.get(url, params=params, headers=headers)

                if resp.status_code in (412, 429):
                    # 频控响应延迟后重试
                    await asyncio.sleep((2 ** (attempt - 1)) + random.random())
                    continue

                if resp.status_code >= 500:
                    # 服务端错误重试
                    await asyncio.sleep((2 ** (attempt - 1)) + random.random() * 0.5)
                    continue

                if resp.status_code != 200:
                    # 不可恢复状态直接失败
                    return None

                # 返回原始文本给解析层处理
                return resp.text
            except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError):
                if attempt == retries:
                    return None
                # 连接超时等异常延迟重试
                await asyncio.sleep((2 ** (attempt - 1)) + random.random() * 0.5)
            except Exception:
                # 其他异常直接失败
                return None
        return None

    def _normalize_bilibili_item(self, item: Dict, search_query: str) -> Optional[Dict]:
        """
        规范化 B 站原始结果项

        Args:
            item (Dict): 原始条目字典
            search_query (str): 查询词

        Returns:
            Optional[Dict]: 标准化结果字典 无标题时返回 None

        Examples:
            >>> row = svc._normalize_bilibili_item({"title": "a"}, "魔裁")
        """
        # 清理 HTML 标签后的标题
        title = re.sub(r"<[^>]+>", "", str(item.get("title") or "")).strip()
        if not title:
            return None

        # 读取 bvid 与缩略图字段
        bvid = str(item.get("bvid") or "").strip()
        pic = str(item.get("pic") or item.get("cover") or "").strip()
        if pic.startswith("//"):
            # 兼容协议相对地址
            pic = "https:" + pic

        # 时间戳转换为 yyyy-mm-dd
        pubdate = item.get("pubdate") or item.get("pub_time") or 0
        date_str = ""
        try:
            if pubdate:
                date_str = datetime.fromtimestamp(int(pubdate)).strftime("%Y-%m-%d")
        except Exception:
            date_str = ""

        # 解析播放量 弹幕量 时长 作者
        play = self._parse_count(item.get("play", 0))
        danmaku = self._parse_count(item.get("video_review", item.get("danmaku", 0)))
        duration = self._normalize_duration(item.get("duration", ""))
        author = str(item.get("author") or item.get("up_name") or "").strip()

        # 清理描述中的 HTML 标签
        description = str(item.get("description") or item.get("desc") or "").strip()
        description = re.sub(r"<[^>]+>", "", description)

        # 根据标题与描述匹配分类与角色
        category, category_label = self._match_category(title, description)
        character, character_name = self._match_character(title, description)

        # 优先使用接口给出的链接 否则根据 bvid 拼接
        url = str(item.get("arcurl") or "").strip()
        if not url and bvid:
            url = f"https://www.bilibili.com/video/{bvid}"

        # 计算稳定 id
        uid_seed = bvid or url or title
        uid = hashlib.md5(uid_seed.encode("utf-8")).hexdigest()[:12]

        # 返回统一结构
        return {
            "id": f"bili_{uid}",
            "title": title,
            "url": url,
            "source": "bilibili",
            "source_label": "B站",
            "thumbnail": pic,
            "date": date_str,
            "author": author,
            "description": description[:220],
            "category": category,
            "category_label": category_label,
            "play_count": play,
            "danmaku_count": danmaku,
            "duration": duration,
            "bvid": bvid,
            "search_keyword": search_query,
            "character": character,
            "character_name": character_name,
        }

    def _normalize_duration(self, value) -> str:
        """
        统一时长字段格式

        Args:
            value (Any): 原始时长值

        Returns:
            str: 规范化时长字符串

        Examples:
            >>> svc._normalize_duration("1:20")
        """
        # 空值直接返回空字符串
        if value is None:
            return ""
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return ""
            try:
                # 支持 hh:mm:ss mm:ss s 三种格式
                parts = [int(p) for p in text.split(":") if p != ""]
                if len(parts) == 3:
                    h, m, s = parts
                    total_seconds = h * 3600 + m * 60 + s
                elif len(parts) == 2:
                    m, s = parts
                    total_seconds = m * 60 + s
                elif len(parts) == 1:
                    total_seconds = parts[0]
                else:
                    return text
                return self._format_duration(total_seconds)
            except Exception:
                # 字符串不可解析时保留原值
                return text
        if isinstance(value, int):
            # 整数按秒处理
            return self._format_duration(value)
        # 其他类型转字符串返回
        return str(value)

    def _format_duration(self, total_seconds: int) -> str:
        """
        将秒数格式化为时长文本

        Args:
            total_seconds (int): 总秒数

        Returns:
            str: mm:ss 或 hh:mm:ss

        Examples:
            >>> svc._format_duration(65)
            '01:05'
        """
        # 防止负值
        total_seconds = max(int(total_seconds), 0)
        if total_seconds <= 3600:
            # 小于一小时输出 mm:ss
            m, s = divmod(total_seconds, 60)
            return f"{m:02d}:{s:02d}"
        # 超过一小时输出 hh:mm:ss
        m, s = divmod(total_seconds, 60)
        h, m = divmod(m, 60)
        return f"{h:02d}:{m:02d}:{s:02d}"

    def _parse_count(self, raw) -> int:
        """
        解析播放量或弹幕量文本

        Args:
            raw (Any): 原始数量值

        Returns:
            int: 解析后的整数数量

        Examples:
            >>> svc._parse_count("1.2万")
            12000
        """
        # 空值返回 0
        if raw is None:
            return 0
        # 去除空格与千分位符号
        text = str(raw).strip().lower().replace(",", "")
        try:
            if "万" in text:
                return int(float(text.replace("万", "")) * 10000)
            if text.endswith("w"):
                return int(float(text[:-1]) * 10000)
            return int(float(text))
        except Exception:
            # 解析失败回退 0
            return 0

    def _build_cache_key(
        self,
        source: str,
        search_query: str,
        limit: int,
        page: int,
        pref_chars: Sequence[str],
    ) -> str:
        """
        生成请求缓存键

        Args:
            source (str): 数据源
            search_query (str): 查询词
            limit (int): 上限
            page (int): 页码
            pref_chars (Sequence[str]): 偏好角色列表

        Returns:
            str: MD5 缓存键

        Examples:
            >>> key = svc._build_cache_key("bilibili", "魔裁", 50, 1, [])
        """
        # 使用稳定 JSON 串生成哈希
        raw = json.dumps(
            {
                "source": source,
                "search_query": search_query,
                "limit": limit,
                "page": page,
                "default_query": DEFAULT_QUERY,
                "pref_chars": sorted(pref_chars),
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        # 返回固定长度 md5 作为缓存键
        return hashlib.md5(raw.encode("utf-8")).hexdigest()

    def _normalize_list(self, values: Optional[Sequence[str]]) -> List[str]:
        """
        清洗字符串列表

        Args:
            values (Optional[Sequence[str]]): 原始列表

        Returns:
            List[str]: 去空白后的列表

        Examples:
            >>> svc._normalize_list([" a ", ""])
            ['a']
        """
        # 空输入返回空列表
        if not values:
            return []
        # 仅保留非空字符串并去掉首尾空白
        return [v.strip() for v in values if isinstance(v, str) and v.strip()]

    def _compose_search_query(self, user_query: Optional[str]) -> str:
        """
        组装最终检索词 默认(魔法少女的魔女审判) + 其他

        Args:
            user_query (Optional[str]): 用户输入词

        Returns:
            str: 合并后的检索词

        Examples:
            >>> svc._compose_search_query("希罗")
            '魔法少女的魔女审判 希罗'
        """
        # 先清洗用户输入
        text = (user_query or "").strip()
        if not text:
            # 无输入时使用默认查询词
            return DEFAULT_QUERY
        if text == DEFAULT_QUERY or text.startswith(f"{DEFAULT_QUERY} "):
            # 已包含默认查询词时直接返回
            return text
        # 其他情况在前面补上默认查询词
        return f"{DEFAULT_QUERY} {text}"

    def _build_preference_terms(self, preferred_characters: Sequence[str]) -> List[str]:
        """
        根据角色偏好生成偏好检索词

        Args:
            preferred_characters (Sequence[str]): 角色键列表

        Returns:
            List[str]: 去重后的中文角色名列表

        Examples:
            >>> terms = svc._build_preference_terms(["Ema"])
        """
        terms: List[str] = []

        # 将角色键映射为中文显示名
        for char_key in preferred_characters:
            char = CHARACTERS.get(char_key)
            if char and char.get("cn"):
                terms.append(char["cn"])

        # 去重并保持原始顺序
        out = []
        seen = set()
        for term in terms:
            if term in seen:
                continue
            seen.add(term)
            out.append(term)
        return out

    def _match_category(self, title: str, desc: str) -> Tuple[str, str]:
        """
        按关键词匹配分类

        Args:
            title (str): 标题
            desc (str): 描述

        Returns:
            Tuple[str, str]: 分类键 与 分类标签
        """
        hay = f"{title} {desc}".lower()
        # 依次匹配分类规则关键词
        for rule in CATEGORY_RULES:
            for kw in rule.get("keywords", []):
                if kw.lower() in hay:
                    cat = rule["category"]
                    return cat, CATEGORY_LABELS.get(cat, CATEGORY_LABELS["other"])
        # 无命中则归类为 other
        return "other", CATEGORY_LABELS["other"]

    def _match_character(self, title: str, desc: str) -> Tuple[str, str]:
        """
        匹配角色名称

        Args:
            title (str): 标题
            desc (str): 描述

        Returns:
            Tuple[str, str]: 角色键 与中文名
        """
        hay = f"{title} {desc}"
        # 遍历角色配置进行名称匹配
        for key, info in CHARACTERS.items():
            # 组合中文名 日文名 与简称
            names = [info.get("cn", ""), info.get("jp", "")] + info.get("short", [])
            if any(name and name in hay for name in names):
                return key, info.get("cn", "")
        # 未识别时返回空角色
        return "", ""

    def _item_unique_id(self, item: Dict) -> str:
        """
        生成条目唯一哈希

        Args:
            item (Dict): 新闻条目字典

        Returns:
            str: 条目哈希
        """
        source = item.get("source", "")
        bvid = item.get("bvid", "")
        url = item.get("url", "")
        title = item.get("title", "")
        # 组合关键字段形成稳定唯一种子
        seed = f"{source}|{bvid}|{url}|{title}"
        # 对种子做 md5 得到稳定短标识
        return hashlib.md5(seed.encode("utf-8")).hexdigest()

    def _merge_with_ratio(
        self,
        base_items: List[Dict],
        pref_items: List[Dict],
        base_limit: int,
        pref_limit: int,
        total_limit: int,
    ) -> List[Dict]:
        """
        按配额合并基础结果与偏好结果

        Args:
            base_items (List[Dict]): 基础结果列表
            pref_items (List[Dict]): 偏好结果列表
            base_limit (int): 基础配额
            pref_limit (int): 偏好配额
            total_limit (int): 总上限

        Returns:
            List[Dict]: 合并去重后的结果
        """
        merged: List[Dict] = []
        seen: Set[str] = set()

        # 先填充偏好配额
        pref_take = pref_items[:pref_limit] if pref_limit > 0 else []
        for item in pref_take:
            uid = self._item_unique_id(item)
            if uid in seen:
                continue
            seen.add(uid)
            merged.append(item)

        # 再填充基础配额
        base_take = base_items[:base_limit] if base_limit > 0 else []
        for item in base_take:
            uid = self._item_unique_id(item)
            if uid in seen:
                continue
            seen.add(uid)
            merged.append(item)

        # 如果任一侧不足则互相补齐
        if len(merged) < total_limit:
            for bucket in (pref_items, base_items):
                # 继续按原有顺序补齐剩余名额
                for item in bucket:
                    uid = self._item_unique_id(item)
                    if uid in seen:
                        continue
                    seen.add(uid)
                    merged.append(item)
                    if len(merged) >= total_limit:
                        break
                if len(merged) >= total_limit:
                    break

        return merged[:total_limit]

    def _sort_with_preference_score(self, items: List[Dict], preference_terms: Sequence[str]) -> List[Dict]:
        """
        按偏好命中与热度排序

        Args:
            items (List[Dict]): 条目列表
            preference_terms (Sequence[str]): 偏好词列表

        Returns:
            List[Dict]: 排序后的条目列表
        """
        if not items:
            return items

        # 预处理偏好词为小写
        pref_terms = [t.lower() for t in preference_terms]

        def _score(it: Dict) -> Tuple[int, int, str]:
            # 标题与描述统一小写后做命中判断
            title = (it.get("title") or "").lower()
            desc = (it.get("description") or "").lower()
            # 任一偏好词在标题或描述中出现即视为命中
            hit = any(term in title or term in desc for term in pref_terms)
            # 次级排序使用播放量
            play = int(it.get("play_count") or 0)
            # 末级排序使用日期字符串
            date = it.get("date") or ""
            return (1 if hit else 0, play, date)

        # 命中优先 热度其次 日期再次
        return sorted(items, key=_score, reverse=True)

    def _parse_pub_date(self, raw: str) -> str:
        """
        解析 RSS 发布时间

        Args:
            raw (str): 原始日期文本

        Returns:
            str: 规范日期字符串

        Examples:
            >>> txt = svc._parse_pub_date("Mon, 01 Jan 2024 00:00:00 GMT")
        """
        raw = raw.strip()
        # 依次尝试常见 RSS 日期格式
        for fmt in ("%a, %d %b %Y %H:%M:%S %Z", "%a, %d %b %Y %H:%M:%S %z"):
            try:
                return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
            except Exception:
                continue
        # 兜底返回前 10 位
        return raw[:10]

    def get_sources(self) -> List[Dict]:
        """
        获取可用来源配置

        Args:
            None:

        Returns:
            List[Dict]: 来源列表
        """
        # 返回前端来源下拉选项
        # icon 字段用于来源标识展示
        return [
            {"id": "bilibili", "name": "B站", "icon": "📺"},
            {"id": "baidu", "name": "百度", "icon": "🔵"},
            {"id": "google", "name": "Google", "icon": "🔍"},
        ]

    def get_categories(self) -> List[Dict]:
        """
        获取可用分类配置

        Args:
            None:

        Returns:
            List[Dict]: 分类列表
        """
        # 过滤 other 保持分类面板简洁
        # 返回值按 CATEGORY_LABELS 当前顺序构造
        return [{"id": key, "name": value} for key, value in CATEGORY_LABELS.items() if key != "other"]

    def get_characters(self) -> List[Dict]:
        """
        获取角色配置列表

        Args:
            None:

        Returns:
            List[Dict]: 角色信息列表
        """
        # 输出角色主键 中文名 与日文名
        # 该结果用于前端筛选与偏好配置
        return [{"id": key, "name": info["cn"], "name_jp": info["jp"]} for key, info in CHARACTERS.items()]
