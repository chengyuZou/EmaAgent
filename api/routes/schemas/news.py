from pydantic import BaseModel


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
    - search_keyword (str): 搜索关键字
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
