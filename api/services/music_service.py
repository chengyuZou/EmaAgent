"""
音乐服务模块

该模块提供本地音乐扫描 播放列表管理 搜索与格式转换能力
"""
import os
from pathlib import Path
from typing import List, Dict, Optional
import json
import re
from datetime import datetime
from urllib.parse import unquote

from utils.logger import logger

_INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _sanitize_filename_stem(name: str, fallback: str = "track") -> str:
    """
    将任意文本转换为安全文件名（不含后缀）
    """
    cleaned = _INVALID_FILENAME_CHARS.sub("_", name).strip().strip(".")
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned or fallback


def _get_audio_duration(file_path: Path) -> float:
    """
    读取音频时长

    优先使用 mutagen 读取时长 失败时返回 0

    Args:
        file_path (Path): 音频文件路径

    Returns:
        float: 音频时长 秒

    Examples:
        >>> sec = _get_audio_duration(Path("a.mp3"))
        >>> isinstance(sec, float)
        True
    """
    try:
        from mutagen import File as MutaFile
        audio = MutaFile(str(file_path))
        if audio and audio.info:
            return round(audio.info.length, 2)
    except Exception as e:
        logger.warning(f"获取音频时长失败: {e}")
        pass
    return 0.0


def _sort_key(track: Dict):
    """
    构建播放列表排序键

    排序优先级为 收藏 最近播放时间 播放次数 时长 语言特征 标题

    Args:
        track (Dict): 歌曲信息字典

    Returns:
        tuple: 可用于 sorted 的排序键

    Examples:
        >>> key = _sort_key({"title": "A"})
        >>> isinstance(key, tuple)
        True
    """
    # 判断标题首字符是否为拉丁字母以提升中文排序优先级
    title: str = track.get("title", "")
    # 如果标题存在且首字符是拉丁字母 则 is_latin 为 True 否则为 False
    first_char = title[0] if title else ""
    # ASCII 码小于 128 的字符被认为是拉丁字母或常见符号 否则可能是中文等非拉丁字符
    is_latin = ord(first_char) < 128 if first_char else True

    # 解析最后播放时间为时间戳 失败时默认为 0
    last_played_str = track.get("last_played")
    # 如果 last_played_str 存在 则尝试解析为 datetime 对象 并转换为时间戳
    if last_played_str:
        try:
            last_played_ts = datetime.fromisoformat(last_played_str).timestamp()
        except Exception:
            last_played_ts = 0
    else:
        last_played_ts = 0

    # 排序键构建为一个元组 按照收藏状态 最近播放时间 播放次数 时长 语言特征 标题进行排序
    return (
        not track.get("is_favorited", False), 
        -last_played_ts,
        -track.get("play_count", 0),
        track.get("duration", 0),
        not is_latin,
        title.lower()
    )


class MusicService:
    """
    本地音乐服务

    该类负责音乐目录扫描 播放列表维护 元数据更新 与文件转换

    Args:
        music_dir (Path): 本地音乐目录

    Returns:
        MusicService: 音乐服务实例

    Examples:
        >>> svc = MusicService(Path("./data/music"))
        >>> isinstance(svc, MusicService)
        True
    """

    def __init__(self, music_dir: Path):
        """
        初始化音乐服务

        Examples:
            >>> svc = MusicService(Path("./data/music"))
            >>> svc.music_dir.exists()
            True
        """
        # 确保音乐目录存在 不存在则创建
        self.music_dir = Path(music_dir)
        self.music_dir.mkdir(parents=True, exist_ok=True)
        # 播放列表文件路径
        self.playlist_file = self.music_dir / "playlist.json"

        # 封面图片目录路径
        self.covers_dir = self.music_dir / "covers"
        self.covers_dir.mkdir(parents=True, exist_ok=True)

        # 内存中的播放列表数据结构 初始化为空列表 后续加载或扫描填充
        self._playlist: List[Dict] = []
        self._load_playlist()

    def _load_playlist(self):
        """
        加载播放列表文件

        若文件不存在则扫描目录创建新列表

        Examples:
            >>> svc._load_playlist()
            >>> isinstance(svc._playlist, list)
            True
        """
        if self.playlist_file.exists():
            try:
                with open(self.playlist_file, "r", encoding="utf-8") as f:
                    self._playlist = json.load(f)
                for t in self._playlist:
                    t.setdefault("play_count", 0)
                    t.setdefault("last_played", None)
                    t.setdefault("is_favorited", False)
                    t.setdefault("cover_art", None)
                    if not t.get("duration"):
                        p = Path(t.get("path", ""))
                        if p.exists():
                            t["duration"] = _get_audio_duration(p)
                self._save_playlist()
            except Exception:
                self._playlist = []
        else:
            self._scan_music_dir()

    def _save_playlist(self):
        """
        保存播放列表到磁盘

        Args:
            None:

        Returns:
            None

        Examples:
            >>> svc._save_playlist()
            >>> svc.playlist_file.exists()
            True
        """
        with open(self.playlist_file, 'w', encoding='utf-8') as f:
            json.dump(self._playlist, f, ensure_ascii=False, indent=2)

    def _scan_music_dir(self):
        """
        扫描音乐目录并重建播放列表

        Args:
            None

        Returns:
            None

        Examples:
            >>> svc._scan_music_dir()
            >>> isinstance(svc._playlist, list)
            True
        """
        self._playlist = []

        audio_extensions = {'.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac'}

        for file in self.music_dir.iterdir():
            if file.suffix.lower() in audio_extensions:
                duration = _get_audio_duration(file)
                self._playlist.append({
                    "id": file.stem,
                    "title": file.stem,
                    "artist": "Unknown",
                    "path": str(file),
                    "url": f"/api/music/{file.name}",
                    "duration": duration,
                    "play_count": 0,
                    "last_played": None,
                    "is_favorited": False,
                    "cover_art": None,
                    "added_at": datetime.now().isoformat(),
                })

        self._save_playlist()

    def _find_track(self, track_id: str) -> Optional[Dict]:
        """
        按 ID 查找歌曲

        Args:
            track_id (str): 歌曲 ID

        Returns:
            Optional[Dict]: 命中的歌曲字典或 None

        Examples:
            >>> t = svc._find_track("demo")
            >>> t is None or isinstance(t, dict)
            True
        """
        for track in self._playlist:
            if track["id"] == track_id:
                return track
        return None

    def _is_same_path(self, a: Path, b: Path) -> bool:
        """
        判断两个路径是否指向同一位置
        """
        try:
            return a.resolve() == b.resolve()
        except Exception:
            return str(a) == str(b)

    def _build_unique_path(self, directory: Path, stem: str, suffix: str, current_path: Optional[Path] = None) -> Path:
        """
        在目录内构建不冲突的文件路径
        """
        idx = 0
        while True:
            filename = f"{stem}{suffix}" if idx == 0 else f"{stem}_{idx}{suffix}"
            candidate = directory / filename
            if not candidate.exists():
                return candidate
            if current_path is not None and self._is_same_path(candidate, current_path):
                return candidate
            idx += 1

    def _cover_path_from_url(self, cover_url: Optional[str]) -> Optional[Path]:
        """
        从封面 URL 反推磁盘路径
        """
        if not cover_url:
            return None
        filename = Path(unquote(cover_url)).name
        if not filename:
            return None
        return self.covers_dir / filename

    def _delete_track_files(self, track: Dict):
        """
        删除单曲关联的音频与封面文件（若存在）
        """
        audio_path = Path(track.get("path", ""))
        if audio_path.exists() and audio_path.is_file():
            try:
                audio_path.unlink()
            except Exception as e:
                logger.warning(f"删除音频文件失败: {audio_path}, error={e}")

        cover_url = track.get("cover_art")
        if cover_url:
            in_use = any(
                t.get("id") != track.get("id") and t.get("cover_art") == cover_url
                for t in self._playlist
            )
            if not in_use:
                cover_path = self._cover_path_from_url(cover_url)
                if cover_path and cover_path.exists() and cover_path.is_file():
                    try:
                        cover_path.unlink()
                    except Exception as e:
                        logger.warning(f"删除封面文件失败: {cover_path}, error={e}")

    def get_playlist(self, sorted_: bool = True) -> List[Dict]:
        """
        获取播放列表

        Args:
            sorted_ (bool): 是否按规则排序

        Returns:
            List[Dict]: 歌曲列表

        Examples:
            >>> pl = svc.get_playlist()
            >>> isinstance(pl, list)
            True
        """
        if sorted_:
            return sorted(self._playlist, key=_sort_key)
        else:
            return list(self._playlist)

    def add_track(self, file_path: str, title: str = None, artist: str = None) -> Dict:
        """
        添加歌曲到播放列表

        Args:
            file_path (str): 音频文件路径
            title (str): 歌曲标题 可选
            artist (str): 歌手名称 可选

        Returns:
            Dict: 新增歌曲字典

        Examples:
            >>> track = svc.add_track("a.mp3")
            >>> "id" in track
            True
        """
        path = Path(file_path)
        duration = _get_audio_duration(path)

        track = {
            "id": path.stem,
            "title": title or path.stem,
            "artist": artist or "Unknown",
            "path": str(path),
            "url": f"/api/music/{path.name}",
            "duration": duration,
            "play_count": 0,
            "last_played": None,
            "is_favorited": False,
            "cover_art": None,
            "added_at": datetime.now().isoformat(),
        }

        self._playlist.append(track)
        self._save_playlist()

        return track

    def remove_track(self, track_id: str) -> bool:
        """
        从列表移除歌曲

        Args:
            track_id (str): 歌曲 ID

        Returns:
            bool: 是否移除成功

        Examples:
            >>> ok = svc.remove_track("demo")
            >>> isinstance(ok, bool)
            True
        """
        result = self.remove_tracks([track_id])
        return len(result["removed"]) > 0

    def remove_tracks(self, track_ids: List[str]) -> Dict[str, List[str]]:
        """
        批量删除歌曲及其磁盘文件

        Args:
            track_ids (List[str]): 待删除歌曲 ID 列表

        Returns:
            Dict[str List[str]]: {"removed": [...], "missing": [...]}
        """
        ordered_ids = [tid for tid in track_ids if tid]
        if not ordered_ids:
            return {"removed": [], "missing": []}

        id_set = set(ordered_ids)
        removed_tracks: List[Dict] = []
        kept_tracks: List[Dict] = []

        for track in self._playlist:
            if track.get("id") in id_set:
                removed_tracks.append(track)
            else:
                kept_tracks.append(track)

        removed_id_set = {t.get("id") for t in removed_tracks}
        removed: List[str] = []
        removed_seen = set()
        missing: List[str] = []
        missing_seen = set()
        for tid in ordered_ids:
            if tid in removed_id_set:
                if tid not in removed_seen:
                    removed.append(tid)
                    removed_seen.add(tid)
            elif tid not in missing_seen:
                missing.append(tid)
                missing_seen.add(tid)

        self._playlist = kept_tracks
        for track in removed_tracks:
            self._delete_track_files(track)

        if removed_tracks:
            self._save_playlist()

        return {"removed": removed, "missing": missing}

    def record_play(self, track_id: str) -> Optional[Dict]:
        """
        记录播放次数与最后播放时间

        Args:
            track_id (str): 歌曲 ID

        Returns:
            Optional[Dict]: 更新后的歌曲字典或 None

        Examples:
            >>> t = svc.record_play("demo")
            >>> t is None or "play_count" in t
            True
        """
        track = self._find_track(track_id)
        if not track:
            return None

        track["play_count"] += 1
        track["last_played"] = datetime.now().isoformat()
        self._save_playlist()
        return track

    def toggle_favorite(self, track_id: str) -> Optional[Dict]:
        """
        切换收藏状态

        Args:
            track_id (str): 歌曲 ID

        Returns:
            Optional[Dict]: 更新后的歌曲字典或 None

        Examples:
            >>> t = svc.toggle_favorite("demo")
            >>> t is None or "is_favorited" in t
            True
        """
        track = self._find_track(track_id)
        if not track:
            return None
        track["is_favorited"] = not track.get("is_favorited", False)
        self._save_playlist()
        return track

    def update_duration(self, track_id: str, duration: float) -> Optional[Dict]:
        """
        更新歌曲时长

        Args:
            track_id (str): 歌曲 ID
            duration (float): 时长 秒

        Returns:
            Optional[Dict]: 更新后的歌曲字典或 None

        Examples:
            >>> t = svc.update_duration("demo", 120.0)
            >>> t is None or "duration" in t
            True
        """
        track = self._find_track(track_id)
        if not track:
            return None
        if duration > 0:
            track["duration"] = round(duration, 2)
            self._save_playlist()
        return track

    def update_cover(self, track_id: str, cover_url: str) -> Optional[Dict]:
        """
        更新歌曲封面 URL

        Args:
            track_id (str): 歌曲 ID
            cover_url (str): 封面访问地址

        Returns:
            Optional[Dict]: 更新后的歌曲字典或 None

        Examples:
            >>> t = svc.update_cover("demo", "/cover.jpg")
            >>> t is None or "cover_art" in t
            True
        """
        track = self._find_track(track_id)
        if not track:
            return None
        track["cover_art"] = cover_url
        self._save_playlist()
        return track

    def rename_track(self, track_id: str, new_title: str, new_artist: str = None) -> Optional[Dict]:
        """
        修改歌曲标题与歌手

        Args:
            track_id (str): 歌曲 ID
            new_title (str): 新标题
            new_artist (str): 新歌手 可选

        Returns:
            Optional[Dict]: 更新后的歌曲字典或 None

        Examples:
            >>> t = svc.rename_track("demo", "new")
            >>> t is None or "title" in t
            True
        """
        track = self._find_track(track_id)
        if not track:
            return None

        normalized_title = (new_title or "").strip()
        if normalized_title:
            track["title"] = normalized_title

            source_path = Path(track.get("path", ""))
            if source_path.exists() and source_path.is_file():
                safe_stem = _sanitize_filename_stem(normalized_title, fallback=source_path.stem or "track")
                target_path = self._build_unique_path(
                    directory=self.music_dir,
                    stem=safe_stem,
                    suffix=source_path.suffix,
                    current_path=source_path,
                )

                if not self._is_same_path(source_path, target_path):
                    source_path.rename(target_path)

                track["id"] = target_path.stem
                track["path"] = str(target_path)
                track["url"] = f"/api/music/{target_path.name}"

                cover_path = self._cover_path_from_url(track.get("cover_art"))
                if cover_path and cover_path.exists() and cover_path.is_file():
                    cover_target = self._build_unique_path(
                        directory=self.covers_dir,
                        stem=target_path.stem,
                        suffix=cover_path.suffix,
                        current_path=cover_path,
                    )
                    if not self._is_same_path(cover_path, cover_target):
                        cover_path.rename(cover_target)
                    track["cover_art"] = f"/api/music/covers/{cover_target.name}"

        if new_artist is not None:
            track["artist"] = new_artist.strip() or track["artist"]
        self._save_playlist()
        return track

    def convert_track(self, track_id: str, target_format: str) -> Optional[Path]:
        """
        转换音频格式并返回输出路径

        该方法先尝试 pydub 失败后再回退 ffmpeg 子进程

        Args:
            track_id (str): 歌曲 ID
            target_format (str): 目标格式 例如 mp3 wav flac

        Returns:
            Optional[Path]: 转换后文件路径 失败返回 None

        Examples:
            >>> p = svc.convert_track("demo", "mp3")
            >>> p is None or isinstance(p, Path)
            True
        """
        # 根据 track_id 查找歌曲信息 如果未找到或文件不存在 则返回 None
        track = self._find_track(track_id)
        if not track:
            return None
        
        # 构建源文件路径和目标文件路径 目标文件命名为 原文件名_converted.目标格式
        source_path = Path(track["path"])
        if not source_path.exists():
            return None
        
        # 规范化目标格式字符串 去除点号并转换为小写 例如 ".MP3" -> "mp3"
        target_format = target_format.lower().lstrip(".")
        # 目标路径位于音乐目录下 命名为 原文件名_converted.目标格式 例如 "song_converted.mp3"
        target_path = self.music_dir / f"{source_path.stem}_converted.{target_format}"

        try:
            # 优先使用 pydub 进行格式转换 该库支持多种格式且易于使用 但可能在某些环境下安装或运行失败
            from pydub import AudioSegment  # type: ignore
            audio = AudioSegment.from_file(str(source_path))
            audio.export(str(target_path), format=target_format)
            return target_path
        except Exception:
            pass

        try:
            # 回退使用 ffmpeg 命令行工具进行格式转换 该工具功能强大但需要正确安装和配置环境变量
            import subprocess
            result = subprocess.run(
                ["ffmpeg", "-y", "-i", str(source_path), str(target_path)],
                capture_output=True,
                timeout=120,
            )
            if result.returncode == 0 and target_path.exists():
                return target_path
        except Exception:
            pass

        return None

    def search_local(self, query: str) -> List[Dict]:
        """
        按标题或歌手搜索本地歌曲

        Args:
            query (str): 搜索关键字

        Returns:
            List[Dict]: 匹配结果列表

        Examples:
            >>> r = svc.search_local("love")
            >>> isinstance(r, list)
            True
        """
        query_lower = query.lower()
        return [
            t for t in self._playlist
            if query_lower in t["title"].lower() or query_lower in t["artist"].lower()
        ]

    def refresh(self) -> List[Dict]:
        """
        重新扫描目录并保留已存在元数据

        Args:
            None

        Returns:
            List[Dict]: 刷新后的播放列表

        Examples:
            >>> pl = svc.refresh()
            >>> isinstance(pl, list)
            True
        """
        existing = {t["id"]: t for t in self._playlist}
        audio_extensions = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"}
        new_list = []
        for file in self.music_dir.iterdir():
            if file.suffix.lower() in audio_extensions:
                if file.stem in existing:
                    track = existing[file.stem]
                    # 路径切换后，同步刷新 path/url，避免保留旧目录值
                    track["path"] = str(file)
                    track["url"] = f"/api/music/{file.name}"
                    if not track.get("duration"):
                        track["duration"] = _get_audio_duration(file)
                    new_list.append(track)
                else:
                    duration = _get_audio_duration(file)
                    new_list.append({
                        "id": file.stem,
                        "title": file.stem,
                        "artist": "Unknown",
                        "path": str(file),
                        "url": f"/api/music/{file.name}",
                        "duration": duration,
                        "play_count": 0,
                        "last_played": None,
                        "is_favorited": False,
                        "cover_art": None,
                        "added_at": datetime.now().isoformat(),
                    })
        self._playlist = new_list
        self._save_playlist()
        return self._playlist


_music_service: Optional[MusicService] = None


def get_music_service() -> MusicService:
    """
    获取音乐服务单例

    Args:
        None

    Returns:
        MusicService: 全局音乐服务实例

    Examples:
        >>> a = get_music_service()
        >>> b = get_music_service()
        >>> a is b
        True
    """
    global _music_service
    from config.paths import get_paths
    paths = get_paths()
    music_dir = paths.music_dir

    # 路径变更后自动重建服务，避免继续读取旧 playlist.json
    if _music_service is None or _music_service.music_dir.resolve() != music_dir.resolve():
        _music_service = MusicService(music_dir)
    return _music_service


def reset_music_service() -> None:
    """
    重置音乐服务单例
    """
    global _music_service
    _music_service = None
