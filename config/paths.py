"""
路径与配置管理模块

该模块集中管理项目路径 配置读取 环境变量加载 与目录初始化
"""

import json
import os
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

try:
    # 可选依赖 yaml 不存在时仅使用 json 配置
    import yaml  # type: ignore
except Exception:
    yaml = None


@dataclass
class PathConfig:
    """
    项目路径配置类

    该类封装所有常用目录路径 与配置文件读写能力
    """

    # 根目录
    root: Path = field(default_factory=lambda: Path(__file__).parent.parent.resolve())

    def __post_init__(self):
        """
        初始化后处理 root 字段

        该方法将字符串路径标准化为绝对 Path 对象
        """
        # 兼容传入字符串 root 的场景
        if isinstance(self.root, str):
            self.root = Path(self.root).resolve()

    def _resolve_runtime_path(self, value: Any, default_path: Path) -> Path:
        """
        解析运行时路径

        规则:
        - 空值回退 default_path
        - 相对路径按项目根目录 root 解析
        - 绝对路径直接使用
        """
        if not isinstance(value, str) or not value.strip():
            return default_path
        p = Path(value.strip())
        if not p.is_absolute():
            p = (self.root / p).resolve()
        return p

    def _settings_paths(self) -> Dict[str, Any]:
        """
        读取 settings.json 中的 paths 配置
        """
        settings = self.load_settings()
        paths_cfg = settings.get("paths")
        if isinstance(paths_cfg, dict):
            return paths_cfg
        return {}

    @property
    def config_dir(self) -> Path:
        """
        获取配置目录路径

        Returns:
            ./EmaAgent/config
        """
        return self.root / "config"

    @property
    def config_json(self) -> Path:
        """
        获取 config.json 路径

        Returns:
            ./EmaAgent/config/config.json
        """
        return self.config_dir / "config.json"

    @property
    def config_yaml(self) -> Path:
        """
        获取 config.yaml 路径

        Returns:
            ./EmaAgent/config/config.yaml
        """
        return self.config_dir / "config.yaml"

    @property
    def settings_json(self) -> Path:
        """
        获取 settings.json 路径

        Returns:
            ./EmaAgent/config/settings.json
        """
        return self.config_dir / "settings.json"

    @property
    def agent_dir(self) -> Path:
        """
        获取 agent 目录路径

        Returns:
            ./EmaAgent/agent
        """
        return self.root / "agent"

    @property
    def llm_dir(self) -> Path:
        """
        获取 llm 目录路径

        Returns:
            ./EmaAgent/llm
        """
        return self.root / "llm"

    @property
    def prompts_dir(self) -> Path:
        """
        获取 prompts 目录路径

        Returns:
            ./EmaAgent/prompts
        """
        return self.root / "prompts"

    @property
    def tools_dir(self) -> Path:
        """
        获取 tools 目录路径

        Returns:
            ./EmaAgent/tools
        """
        return self.root / "tools"

    @property
    def utils_dir(self) -> Path:
        """
        获取 utils 目录路径

        Returns:
            ./EmaAgent/utils
        """
        return self.root / "utils"

    @property
    def data_dir(self) -> Path:
        """
        获取 data 目录路径

        Returns:
            ./EmaAgent/data
        """
        defaults = self.root / "data"
        return self._resolve_runtime_path(
            self._settings_paths().get("data_dir"),
            defaults,
        )
    
    @property
    def puzzle_dir(self) -> Path:
        """
        获取拼图图片目录路径

        Returns:
            ./EmaAgent/data/puzzle_images
        """
        return self.data_dir / "puzzle_images"

    @property
    def music_dir(self) -> Path:
        """
        获取音乐目录路径

        Returns:
            ./EmaAgent/data/music 或 settings.paths.music_dir
        """
        defaults = self.data_dir / "music"
        return self._resolve_runtime_path(
            self._settings_paths().get("music_dir"),
            defaults,
        )

    @property
    def memory_dir(self) -> Path:
        """
        获取 memory 目录路径

        Returns:
            ./EmaAgent/memory
        """
        return self.root / "memory"

    @property
    def sessions_dir(self) -> Path:
        """
        获取 sessions 目录路径

        该属性会确保 data/sessions 目录存在

        Returns:
            ./EmaAgent/data/sessions
        """
        # 会话目录统一放在 data 下
        path = self.data_dir / "sessions"
        # 访问属性时自动创建目录
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def narrative_dir(self) -> Path:
        """
        获取 narrative 目录路径

        Returns:
            ./EmaAgent/narrative
        """
        return self.root / "narrative"

    @property
    def narrative_memory_dir(self) -> Path:
        """
        获取 narrative memory 目录路径

        Returns:
            ./EmaAgent/narrative/memory
        """
        return self.narrative_dir / "memory"

    @property
    def timeline_dirs(self) -> Dict[str, Path]:
        """
        获取三轮叙事时间线目录映射

        Returns:
            {\n
                "1st_Loop": Path("./EmaAgent/narrative/memory/1st_Loop"),\n
                "2nd_Loop": Path("./EmaAgent/narrative/memory/2nd_Loop"),\n
                "3rd_Loop": Path("./EmaAgent/narrative/memory/3rd_Loop"),\n
            }
        """
        return {
            "1st_Loop": self.narrative_memory_dir / "1st_Loop",
            "2nd_Loop": self.narrative_memory_dir / "2nd_Loop",
            "3rd_Loop": self.narrative_memory_dir / "3rd_Loop",
        }

    @property
    def audio_dir(self) -> Path:
        """
        获取音频根目录路径

        Returns:
            ./EmaAgent/data/audio
        """
        return self.data_dir / "audio"

    @property
    def audio_output_dir(self) -> Path:
        """
        获取合并音频输出目录路径

        Returns:
            ./EmaAgent/data/audio/output
        """
        defaults = self.audio_dir / "output"
        return self._resolve_runtime_path(
            self._settings_paths().get("audio_dir"),
            defaults,
        )

    @property
    def audio_cache_dir(self) -> Path:
        """
        获取音频缓存目录路径

        Returns:
            ./EmaAgent/data/audio/cache
        """
        return self.audio_dir / "cache"

    @property
    def reference_audio_dir(self) -> Path:
        """
        获取参考音频目录路径

        Returns:
            ./EmaAgent/data/audio/Reference_audio
        """
        return self.audio_dir / "Reference_audio"

    @property
    def default_reference_audio(self) -> Path:
        """
        获取默认参考音频文件路径

        Returns:
            ./EmaAgent/data/audio/Reference_audio/ema1.mp3
        """
        return self.reference_audio_dir / "ema1.mp3"

    @property
    def logs_dir(self) -> Path:
        """
        获取日志目录路径

        Returns:
            ./EmaAgent/logs
        """
        defaults = self.root / "logs"
        return self._resolve_runtime_path(
            self._settings_paths().get("log_dir"),
            defaults,
        )

    @property
    def env_file(self) -> Path:
        """
        获取环境变量文件路径

        Returns:
            ./EmaAgent/.env
        """
        return self.root / ".env"

    def load_dotenv(self, override: bool = False) -> None:
        """
        从 .env 文件加载环境变量

        Args:
            override (bool): 是否覆盖已存在环境变量
        """
        # 文件不存在时直接跳过
        if not self.env_file.exists():
            return

        # 按行解析 key=value 格式
        for raw_line in self.env_file.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            # 跳过空行 注释行 与非法格式
            if not line or line.startswith("#") or "=" not in line:
                continue

            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")

            # 按 override 策略写入环境变量
            if override or key not in os.environ:
                os.environ[key] = value

    def _resolve_api_keys(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """
        将配置中的 api_key_env 解析为 api_key

        Args:
            data (Dict[str Any]): 原始配置字典

        Returns:
            Dict[str Any]: 解析后的配置字典
        """
        # 解析顶层 llm embeddings tts 三类配置
        for section in ("llm", "embeddings", "tts"):
            block = data.get(section)
            if not isinstance(block, dict):
                continue

            env_key = block.get("api_key_env")
            if env_key:
                # 用环境变量值覆盖运行时 api_key
                block["api_key"] = os.getenv(env_key, "")

        # 解析模型目录中的 api_key_env
        model_catalog = data.get("llm_models", {})
        if isinstance(model_catalog, dict):
            for _, info in model_catalog.items():
                if not isinstance(info, dict):
                    continue
                env_key = info.get("api_key_env")
                if env_key:
                    info["api_key"] = os.getenv(env_key, "")

        return data

    def load_config(self) -> Dict[str, Any]:
        """
        加载主配置文件

        优先读取 config.json 其次读取 config.yaml
        """
        # 先加载 .env 以便解析 api_key_env
        self.load_dotenv()

        # 优先读取 json 配置
        if self.config_json.exists():
            data = json.loads(self.config_json.read_text(encoding="utf-8"))
            return self._resolve_api_keys(data)

        # 回退读取 yaml 配置 仅在 yaml 依赖可用时启用
        if self.config_yaml.exists() and yaml is not None:
            data = yaml.safe_load(self.config_yaml.read_text(encoding="utf-8"))
            return self._resolve_api_keys(data)

        raise FileNotFoundError(f"Config 文件无法找到: {self.config_json}")

    def load_settings(self) -> Dict[str, Any]:
        """
        读取 settings.json 配置
        """
        # settings 文件不存在时返回默认空字典
        if not self.settings_json.exists():
            return {}
        # 返回解析后的 json 数据
        return json.loads(self.settings_json.read_text(encoding="utf-8"))

    def save_settings(self, settings: Dict[str, Any]) -> None:
        """
        保存 settings.json 配置
        """
        # 确保配置目录存在
        self.settings_json.parent.mkdir(parents=True, exist_ok=True)
        # 以 utf-8 与缩进格式写入
        self.settings_json.write_text(
            json.dumps(settings, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def ensure_directories(self):
        """
        创建运行所需目录
        """
        # 收集需要确保存在的目录列表
        dirs = [
            self.sessions_dir,
            self.data_dir,
            self.memory_dir,
            self.narrative_memory_dir,
            self.audio_output_dir,
            self.audio_cache_dir,
            self.reference_audio_dir,
            self.logs_dir,
        ]
        # 逐个创建目录 已存在时忽略
        for d in dirs:
            d.mkdir(parents=True, exist_ok=True)

    def get_session_file(self, session_id: str) -> Path:
        """
        获取会话 json 文件路径

        Args:
            session_id (str): 会话标识

        Returns:
            Path: 会话文件路径
        """
        return self.sessions_dir / f"{session_id}.json"

    def get_daily_log_dir(self, date: Optional[datetime] = None) -> Path:
        """
        获取按日期分组的日志目录路径

        Args:
            date (Optional[datetime]): 指定日期 为空时使用当前时间

        Returns:
            Path: 当天日志目录路径
        """
        # 未传日期时使用当前时间
        if date is None:
            date = datetime.now()
        return self.logs_dir / date.strftime("%Y-%m-%d")

    def get_audio_cache_file(self, filename: str) -> Path:
        """
        获取缓存音频文件路径

        Args:
            filename (str): 文件名

        Returns:
            Path: cache 文件完整路径
        """
        return self.audio_cache_dir / filename

    def cleanup_audio_cache(self, max_age_hours: int = 24):
        """
        清理过期音频缓存文件

        Args:
            max_age_hours (int): 最大保留时长 单位小时

        Returns:
            None
        """
        # 缓存目录不存在时直接返回
        if not self.audio_cache_dir.exists():
            return

        # 计算过期阈值秒数
        current_time = datetime.now().timestamp()
        max_age_seconds = max_age_hours * 3600

        # 遍历 mp3 文件并删除过期项
        for file in self.audio_cache_dir.glob("*.mp3"):
            try:
                # 文件计算存在时间
                file_age = current_time - file.stat().st_mtime
                if file_age > max_age_seconds:
                    file.unlink()
            except Exception:
                # 单文件异常时继续处理其他文件
                continue

    def to_dict(self) -> Dict[str, str]:
        """
        导出关键路径字典
        """

        return {
            "root": str(self.root),
            "config_json": str(self.config_json),
            "config_yaml": str(self.config_yaml),
            "prompts_dir": str(self.prompts_dir),
            "sessions_dir": str(self.sessions_dir),
            "narrative_memory_dir": str(self.narrative_memory_dir),
            "audio_output_dir": str(self.audio_output_dir),
            "reference_audio": str(self.default_reference_audio),
            "logs_dir": str(self.logs_dir),
        }

    def __repr__(self) -> str:
        """
        返回对象调试字符串
        """

        return f"PathConfig(root={self.root})"


_paths: Optional[PathConfig] = None


def init_paths(root: Path | str) -> PathConfig:
    """
    初始化全局路径配置对象

    Args:
        root (Path | str): 项目根目录路径

    Returns:
        PathConfig: 全局路径配置对象
    """
    
    if isinstance(root, str):
        root = Path(root).resolve()

    global _paths
    # 创建全局 PathConfig 实例
    _paths = PathConfig(root=root)
    # 初始化后立即加载 .env
    _paths.load_dotenv()
    return _paths


def get_paths() -> PathConfig:
    """
    获取全局路径配置对象
    """

    # 未初始化时抛出明确错误
    if _paths is None:
        raise RuntimeError("路径配置未初始化 请先调用 init_paths(root) 进行初始化")
    return _paths
