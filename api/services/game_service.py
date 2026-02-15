"""
游戏服务模块

该模块负责拼图图片目录管理 列表读取 与上传保存
"""
from pathlib import Path
from typing import List, Dict
import shutil
from urllib.parse import unquote, urlparse
from fastapi import UploadFile

from config.paths import get_paths
from utils.logger import logger


class GameService:
    """
    游戏资源服务

    该类用于管理拼图资源目录 并提供图片列表和上传保存能力
    """

    def __init__(self):
        """
        初始化服务并准备目录
        """
        # 获取路径配置并设置拼图目录
        paths = get_paths()
        self.puzzle_dir = paths.puzzle_dir
        self._ensure_directories()
        logger.info(f"GameService已初始化 拼图目录: {self.puzzle_dir}")

    def _ensure_directories(self):
        """
        确保拼图目录存在
        """
        self.puzzle_dir.mkdir(parents=True, exist_ok=True)

    def get_puzzle_images(self) -> List[str]:
        """
        获取可用拼图图片 URL 列表

        Args:
            None:

        Returns:
            List[str]: 前端可访问的静态 URL 列表
        """
        # 定义允许的图片扩展名
        valid_extensions = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
        images = []

        # 扫描目录并收集有效图片文件的 URL
        if self.puzzle_dir.exists():
            for file in sorted(self.puzzle_dir.iterdir()):
                # 检查文件是否为有效图片并添加到列表
                if file.is_file() and file.suffix.lower() in valid_extensions:
                    images.append(f"/static/puzzles/{file.name}")

        logger.info(f"获取拼图图片列表 共{len(images)}张图片")
        return images

    async def save_uploaded_image(self, file: UploadFile) -> str:
        """
        保存上传图片并返回静态 URL

        Args:
            file (UploadFile): 上传文件对象

        Returns:
            str: 图片静态访问路径

        Raises:
            Exception: 文件系统写入异常时由调用方处理
        """
        file_path = self.puzzle_dir / file.filename

        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        logger.info(f"已保存上传图片: {file.filename}")
        return f"/static/puzzles/{file.filename}"

    def _extract_filename(self, raw: str) -> str:
        """
        从 URL 或文件名中提取安全文件名
        """
        if not raw:
            return ""
        text = unquote(raw.strip())
        if "://" in text:
            text = urlparse(text).path
        return Path(text).name

    def delete_image(self, image_ref: str) -> bool:
        """
        删除单张拼图图片

        Args:
            image_ref (str): 图片 URL 或文件名

        Returns:
            bool: 是否删除成功
        """
        filename = self._extract_filename(image_ref)
        if not filename:
            return False

        target = self.puzzle_dir / filename
        if target.exists() and target.is_file():
            target.unlink()
            logger.info(f"已删除拼图图片: {target.name}")
            return True
        return False

    def delete_images(self, image_refs: List[str]) -> Dict[str, List[str]]:
        """
        批量删除拼图图片

        Args:
            image_refs (List[str]): 图片 URL 或文件名列表

        Returns:
            Dict[str List[str]]: {"removed": [...], "missing": [...]}
        """
        ordered = [r for r in image_refs if r]
        removed: List[str] = []
        missing: List[str] = []
        removed_seen = set()
        missing_seen = set()

        for ref in ordered:
            filename = self._extract_filename(ref)
            if not filename:
                continue
            if self.delete_image(filename):
                if filename not in removed_seen:
                    removed.append(filename)
                    removed_seen.add(filename)
            elif filename not in missing_seen:
                missing.append(filename)
                missing_seen.add(filename)

        return {"removed": removed, "missing": missing}


game_service = GameService()
