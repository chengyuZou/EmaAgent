"""
News routes.
"""

from typing import List, Optional

from fastapi import APIRouter, Query

from api.routes.schemas.news import CategoryInfo, CharacterInfo, NewsItem, SourceInfo
from api.services.news_service import NewsService

router = APIRouter(prefix="/api/news", tags=["news"])
news_service = NewsService()


@router.get("", response_model=List[NewsItem])
async def get_news(
    source: str = Query("bilibili", description="source: bilibili/baidu/google"),
    query: Optional[str] = Query(None, description="query keywords"),
    limit: int = Query(100, ge=50, le=200),
    page: int = Query(1, ge=1),
    preferred_sources: Optional[str] = Query(None),
    preferred_characters: Optional[str] = Query(None),
):
    """
    获取新闻列表
    """
    pref_src = preferred_sources.split(",") if preferred_sources else None
    pref_char = preferred_characters.split(",") if preferred_characters else None

    items = await news_service.fetch_news(
        source=source,
        query=query,
        limit=limit,
        page=page,
        preferred_sources=pref_src,
        preferred_characters=pref_char,
    )
    return [NewsItem(**item) for item in items]


@router.get("/sources", response_model=List[SourceInfo])
async def get_sources():
    """
    获取可用来源列表
    """
    return [
        {"id": "bilibili", "name": "B站", "icon": "📺"},
        {"id": "baidu", "name": "百度", "icon": "🔎"},
        {"id": "google", "name": "Google", "icon": "🌍"},
    ]


@router.get("/categories", response_model=List[CategoryInfo])
async def get_categories():
    """
    获取新闻分类列表
    """
    return news_service.get_categories()


@router.get("/characters", response_model=List[CharacterInfo])
async def get_characters():
    """
    获取角色列表
    """
    return news_service.get_characters()
