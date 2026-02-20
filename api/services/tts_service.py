"""
API TTS 服务模块

该模块负责参考音频上传 分段语音生成 合并输出 与缓存清理
"""

import os
import re
import time
from pathlib import Path
from threading import Lock, Thread
from typing import Dict, List, Any, Optional

from config.paths import get_paths
from utils.logger import logger

from api.services.tts import TTSFactory
from api.services.tts import BaseTTSProvider
from api.services.tts import SiliconflowTTSProvider
from api.services.tts import VitsSimpleApiTTSProvider

# 清理动作描述文本 例如 (笑) （叹气）
ACTION_REMOVE_REGEX = re.compile(r"（[^）]*）|\([^)]*\)|\*[^*]*\*", flags=re.DOTALL)
# 合并后延迟删除分段文件 避免首播时 404
CHUNK_DELETE_DELAY_SECONDS = 180

class APITTSService:
    """
    API TTS 单例服务

    该类管理音色上传状态 并提供文本转语音与音频合并能力

    由原先的 TTSManager 更改而来 适配 API 调用方式 并增加了音色上传与文本清洗功能
    """

    _instance: Optional["APITTSService"] = None
    _lock = Lock()

    def __new__(cls):
        """
        创建或返回单例对象
        """
        # 双重检查锁 防止并发场景重复构造
        if cls._instance is None:
            with cls._lock:
                # 加锁后再次判断避免并发竞态
                if cls._instance is None:
                    # 创建对象并设置初始化标记
                    cls._instance = super().__new__(cls)
                    # 首次 __init__ 之前保持未初始化状态
                    cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        """
        初始化服务默认配置
        """
        if self._initialized:
            return
        
        # 当前 provider 实例
        self._provider: Optional[BaseTTSProvider] = None
        # 当前 provider 名称
        self._provider_name: Optional[str] = None

        # 切换 provider 时的互斥锁, 防止并发切换导致状态不一致
        # 根据 AI 似乎用 asyncio.Lock 更合适并发场景, 但是这意味着 config 等相关操作也要改成 async 版本
        # 目前先保持简单的线程锁
        self._provider_lock = Lock()

        # 首次加载配置并初始化 Provider
        self._load_provider()
        self._initialized = True

    def _load_tts_settings(self) -> dict:
        """加载 TTS 相关配置

        Returns:
            dict: 包含 provider_name 和 tts_config 的字典
        """
        paths = get_paths()
        settings = paths.load_settings()
        
        tts_full_config = settings.get("api", {}).get("tts", {})
        print(settings)
        provider_name = tts_full_config.get("provider", "")
        tts_config = tts_full_config.get("providers", {}).get(provider_name, {})
        
        # 如果 settings 中没有，从主配置加载
        if not tts_config:
            logger.debug(f"[TTS Service] settings.json 中未找到 provider 配置，尝试从 config.json 加载")
            config = paths.load_config()
            tts_full_config = config.get("tts", {})
            provider_name = tts_full_config.get("provider_name", "")
            tts_config = tts_full_config.get("providers", {}).get(provider_name, {})

        return {"provider_name": provider_name, "tts_config": tts_config}

    def _load_provider(self):
        """
        从配置加载当前 TTS provider
        """
        
        loaded_settings = self._load_tts_settings()
        provider_name, tts_config = loaded_settings["provider_name"], loaded_settings["tts_config"]
        logger.debug(f"[TTS Service] 加载 TTS 配置: provider={provider_name} config={tts_config}")

        with self._provider_lock:
            # 已经是当前 provider 无需重新加载
            if self._provider and self._provider_name == provider_name:
                return

            logger.info(f"[TTS Service] 正在加载 TTS provider: {provider_name}")
            new_provider = TTSFactory.create_provider(provider_name, tts_config)
            if new_provider:
                self._provider = new_provider
                self._provider_name = provider_name
                logger.info(f"[TTS Service] TTS provider 已加载: {provider_name}")
            else:
                # TODO fallback 机制
                logger.error(f"[TTS Service] TTS provider 加载失败: {provider_name}")

    def get_current_provider_name(self) -> str:
        """
        获取当前 Provider 名称
        """
        return self._provider_name or ""

    def reload_service(self):
        """
        重新加载配置并更新 Provider
        """
        self._load_provider()

    def reset_voice(self):
        """
        重置音色上传状态 使下次生成时重新上传参考音频
        """
        with self._provider_lock:
            if self._provider:
                self._provider.reset()

    # NOTE 切换 provider 的接口, 暂时保留
    # 目前暂定为前端在setting/tts put 新设置后直接调用 reload_service 来刷新配置
    # 之后如果有更复杂的切换需求再完善该接口
    '''def switch_provider(self, name: str):
        """
        切换当前 provider 并持久化配置

        Args:
            name (str): provider 名称
            config (Optional[Dict], optional): provider 配置 dict. Defaults to None.
        """
        self._state = APITTSServiceStatus.SWITCHING
        # 若未提供 config，则从 settings 中读取该 provider 的现有配置
        with self._provider_lock:
            # 读取配置、创建新 provider、赋值
            if config is None:
                paths = get_paths()
                settings = paths.load_settings()
                providers_config = settings.get("tts", {}).get("providers", {})
                config = providers_config.get(name, {})
                
                """# 解析环境变量
                if config.get("api_key_env"):
                    config["api_key"] = os.getenv(config["api_key_env"], "")"""
            self._provider = self._create_provider(name, config)
            self._provider_name = name

            # 更新 settings.json 中的当前 provider 名称
            self._save_current_provider_to_settings(name)
            self._state = APITTSServiceStatus.READY
            logger.info(f"[TTS Service] TTS provider switched to: {name}")

    def _save_current_provider_to_settings(self, name: str):
        """
        将当前 provider 名称写入 settings.json

        Args:
            name (str): provider 名称
        """
        paths = get_paths()
        settings = paths.load_settings()
        if "api" not in settings:
            settings["api"] = {}
        if "tts" not in settings["api"]:
            settings["api"]["tts"] = {}
        settings["api"]["tts"]["provider"] = name
        paths.save_settings(settings)'''

    def _clean_text(self, text: str) -> str:
        """
        清洗输入文本

        删除动作括号文本 并去掉省略号符号

        Args:
            text (str): 原始文本

        Returns:
            str: 清洗后文本
        """
        # 空文本直接返回
        if not text:
            return ""

        # 删除括号动作描述
        result = ACTION_REMOVE_REGEX.sub("", text)
        # 删除连续省略符
        result = result.replace("...", "").replace("……", "")
        return result.strip()

    def _is_valid_text(self, text: str) -> bool:
        """
        判断文本是否可发音

        Args:
            text (str): 待检测文本

        Returns:
            bool: 是否存在可读字符
        """
        # 去掉符号后检查有效字符长度
        # 过滤标点与空白后判断是否还有有效字符
        check_text = re.sub(r"[^\w\u4e00-\u9fff]", "", text or "")
        return len(check_text) > 0

    def generate(self, text: str) -> Optional[str]:
        """
        生成单段语音并保存到 cache 目录, provider 对外接口

        Args:
            text (str): 待合成文本

        Returns:
            Optional[str]: 生成文件绝对路径 失败返回 None
        """
        # NOTE 或者可以移入 provider 内部, 但此处先统一处理文本保证可用性最大化, 后续有需求时再进行更改
        clean_text = self._clean_text(text)
        if not self._is_valid_text(clean_text):
            logger.warning(f"无效文本: {text}")
            return None

        if not self._provider:
            logger.error("No TTS provider available")
            return None

        # 获取 cache 目录路径
        paths = get_paths()
        output_dir = paths.audio_cache_dir
        # 确保输出目录存在
        output_dir.mkdir(parents=True, exist_ok=True)

        generate_dir = self._provider.generate(clean_text)
        return generate_dir

    def merge_audio_files(self, file_paths: List[str]) -> Optional[str]:
        """
        合并分段音频到 output 目录

        Args:
            file_paths (List[str]): 分段音频路径列表

        Returns:
            Optional[str]: 合并后文件路径 失败返回 None
        """
        # 空输入直接返回
        if not file_paths:
            return None

        # 过滤不存在路径 防止读文件报错
        valid_files = [Path(p) for p in file_paths if p and Path(p).exists()]
        if not valid_files:
            return None

        # 计算 output 目录并确保存在
        paths = get_paths()
        output_dir = paths.audio_output_dir
        output_dir.mkdir(parents=True, exist_ok=True)
        # 按时间戳生成合并文件名
        merged_path = output_dir / f"speech_merge_{int(time.time() * 1000)}.mp3"

        try:
            # 按顺序拼接音频字节
            with open(merged_path, "wb") as out:
                for file_path in valid_files:
                    # 顺序写入每个分段文件字节
                    out.write(file_path.read_bytes())

            # 合并结果过小时视为失败
            if merged_path.stat().st_size < 10:
                merged_path.unlink(missing_ok=True)
                return None

            # 延迟删除分段文件 避免首播期间请求失败
            self._delete_files_later(
                valid_files, delay_seconds=CHUNK_DELETE_DELAY_SECONDS
            )
            return str(merged_path)
        except Exception as e:
            logger.warning(f"❌ [TTS Service] 合并失败: {e}")
            # 失败时删除可能残留的半成品文件
            merged_path.unlink(missing_ok=True)
            return None

    def _delete_files_later(self, files: List[Path], delay_seconds: int = 120) -> None:
        """
        后台延迟删除分段文件

        Args:
            files (List[Path]): 待删除文件列表
            delay_seconds (int): 延迟秒数

        Returns:
            None
        """

        def _worker():
            # 先等待指定时间
            time.sleep(max(1, int(delay_seconds)))
            # 逐个尝试删除 忽略单文件异常
            for file_path in files:
                try:
                    file_path.unlink(missing_ok=True)
                except Exception:
                    # 单个删除失败不影响其他文件
                    continue

        # 启动后台线程执行延迟清理
        Thread(target=_worker, daemon=True).start()


_tts_service: Optional[APITTSService] = None


def get_tts_service() -> APITTSService:
    """
    获取 TTS 服务单例
    """
    global _tts_service
    # 延迟初始化全局服务
    if _tts_service is None:
        # 只创建一次 后续直接复用
        _tts_service = APITTSService()
    return _tts_service
