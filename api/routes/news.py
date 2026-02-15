"""
新闻路由模块

该模块提供新闻列表 来源 分类 与角色配置接口
"""

from typing import List, Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel

from api.services.news_service import NewsService

router = APIRouter(prefix="/api/news", tags=["news"])
news_service = NewsService()


class NewsItem(BaseModel):
    """
    新闻条目响应模型

    - id (str): 条目标识
    - title (str): 标题
    - url (str): 链接
    - source (str): 来源标识
    - source_label (str): 来源显示名
    - thumbnail (str): 缩略图链接
    - date (str): 日期
    - author (str): 作者
    - description (str): 摘要
    - category (str): 分类标识
    - category_label (str): 分类显示名
    - play_count (int): 播放量
    - danmaku_count (int): 弹幕量
    - duration (str): 时长文本
    - bvid (str): B 站视频号
    - search_keyword (str): 搜索关键词
    - character (str): 角色标识
    - character_name (str): 角色名称
    """

    id: str = ""
    title: str = ""
    url: str = ""
    source: str = ""
    source_label: str = ""
    thumbnail: str = ""
    date: str = ""
    author: str = ""
    description: str = ""
    category: str = ""
    category_label: str = ""
    play_count: int = 0
    danmaku_count: int = 0
    duration: str = ""
    bvid: str = ""
    search_keyword: str = ""
    character: str = ""
    character_name: str = ""


class SourceInfo(BaseModel):
    """
    来源信息模型

    - id (str): 来源标识
    - name (str): 来源名称
    - icon (str): 来源图标
    """

    id: str
    name: str
    icon: str = ""


class CategoryInfo(BaseModel):
    """
    分类信息模型

    - id (str): 分类标识
    - name (str): 分类名称
    """

    id: str
    name: str


class CharacterInfo(BaseModel):
    """
    角色信息模型

    - id (str): 角色标识
    - name (str): 角色名称
    - name_jp (str): 日文名称
    """

    id: str
    name: str
    name_jp: str = ""


@router.get("", response_model=List[NewsItem])
async def get_news(
    source: str = Query("bilibili", description="来源: bilibili/baidu/google"),
    query: Optional[str] = Query(None, description="用户关键词；后端固定拼接“魔裁 + 用户关键词”"),
    limit: int = Query(100, ge=50, le=200),
    page: int = Query(1, ge=1),
    preferred_sources: Optional[str] = Query(None),
    preferred_characters: Optional[str] = Query(None),
):
    """
    获取新闻列表

    Args:
        source (str): 数据来源
        query (Optional[str]): 用户查询词
        limit (int): 返回上限
        page (int): 页码
        preferred_sources (Optional[str]): 偏好来源 逗号分隔
        preferred_characters (Optional[str]): 偏好角色 逗号分隔

    Returns:
        List[NewsItem]: 新闻条目列表
    """
    # 解析来源偏好参数
    pref_src = preferred_sources.split(",") if preferred_sources else None
    # 解析角色偏好参数
    pref_char = preferred_characters.split(",") if preferred_characters else None

    # 调用服务层获取结果
    items = await news_service.fetch_news(
        source=source, query=query, limit=limit, page=page,
        preferred_sources=pref_src,
        preferred_characters=pref_char,
    )
    # 映射为统一响应模型
    return [NewsItem(**item) for item in items]


@router.get("/sources", response_model=List[SourceInfo])
async def get_sources():
    """
    获取可用来源列表

    Args:
        None

    Returns:
        List[SourceInfo]: 来源配置列表
    """
    # 返回前端来源筛选项
    return [
        {"id": "bilibili", "name": "B站", "icon": "📺"},
        {"id": "baidu", "name": "百度", "icon": "🔵"},
        {"id": "google", "name": "Google", "icon": "🔍"},
    ]


@router.get("/categories", response_model=List[CategoryInfo])
async def get_categories():
    """
    获取新闻分类列表

    Args:
        None

    Returns:
        List[CategoryInfo]: 分类列表
    """
    return news_service.get_categories()


@router.get("/characters", response_model=List[CharacterInfo])
async def get_characters():
    """
    获取角色列表

    Args:
        None

    Returns:
        List[CharacterInfo]: 角色配置列表
    """
    return news_service.get_characters()
