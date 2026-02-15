"""
API TTS 服务模块

该模块负责参考音频上传 分段语音生成 合并输出 与缓存清理
"""

import re
import time
from pathlib import Path
from threading import Lock, Thread
from typing import List, Optional

import requests

from config.paths import get_paths
from utils.logger import logger


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
        # 单例重复构造时不重复初始化
        if self._initialized:
            return

        # 固定 API 网关地址
        self.base_url = "https://api.siliconflow.cn/v1"
        # 默认语音模型
        self.default_model = "FunAudioLLM/CosyVoice2-0.5B"
        # 上传后返回的音色 URI 缓存
        self._voice_uri: Optional[str] = None
        # 标记是否已尝试上传过音色
        self._voice_uploaded = False
        # 上传过程互斥锁 防止并发重复上传
        self._upload_lock = Lock()
        self._initialized = True

    def _get_config(self) -> dict:
        """
        读取最新运行配置
        """
        # 先获取统一路径对象
        paths = get_paths()
        # 每次动态读取 避免热更新后配置过期
        return paths.load_config()

    def _get_api_key(self) -> str:
        """
        获取 TTS API Key
        """
        # 从配置中读取 tts.api_key
        config = self._get_config()
        # 未配置时返回空字符串
        return config.get("tts", {}).get("api_key", "")

    def _get_reference_audio_path(self) -> Optional[str]:
        """
        获取参考音频路径

        优先读取新路径 不存在时回退旧目录
        """
        paths = get_paths()
        ref_audio = paths.default_reference_audio
        # 优先使用当前路径配置
        if ref_audio.exists():
            return str(ref_audio)

        # 兼容旧版本目录结构
        legacy_ref_audio = paths.root / "audio" / "Reference_audio" / "ema1.mp3"
        if legacy_ref_audio.exists():
            return str(legacy_ref_audio)

        return None

    def _get_reference_text(self) -> str:
        """
        获取参考音频对应文本
        """
        # 读取配置中的参考文本
        config = self._get_config()
        # 未配置时返回默认参考句
        return config.get(
            "tts",
            {},
        ).get(
            "reference_text",
            "我就是担心这种伤风败俗的东西如果被身心尚幼的小朋友们看到了 会造成不好的影响 所以想提前做好预防措施",
        )

    def _upload_reference_audio(self) -> Optional[str]:
        """
        上传参考音频并返回音色 URI
        """
        # 获取鉴权信息
        api_key = self._get_api_key()
        # 未配置 Key 直接返回
        if not api_key:
            logger.warning("TTS API Key 未配置")
            return None

        # 获取参考音频文件路径
        ref_audio_path = self._get_reference_audio_path()
        # 无参考音频时回退默认音色
        if not ref_audio_path:
            logger.warning("未找到参考音频 使用默认音色")
            return f"{self.default_model}:claire"

        # 构建上传接口地址与请求头
        url = f"{self.base_url}/uploads/audio/voice"
        headers = {"Authorization": f"Bearer {api_key}"}

        try:
            # 以 multipart form 上传参考音频与文本
            with open(ref_audio_path, "rb") as f:
                files = {"file": f}
                data = {
                    "model": self.default_model,
                    "customName": "ema_api_voice",
                    "text": self._get_reference_text(),
                }
                # 发送上传请求
                response = requests.post(url, headers=headers, files=files, data=data, timeout=30)

            # 成功时读取返回 URI
            if response.status_code == 200:
                result = response.json()
                voice_uri = result.get("uri")
                logger.info(f"✅ [API TTS] 音色上传成功: {voice_uri}")
                return voice_uri

            # 失败时打印状态码与响应
            logger.warning(f"❌ [API TTS] 音色上传失败: {response.status_code} - {response.text}")
            return None
        except Exception as e:
            logger.warning(f"❌ [API TTS] 音色上传异常: {e}")
            return None

    def _ensure_voice_uploaded(self) -> Optional[str]:
        """
        确保音色已上传并可用

        Returns:
            Optional[str]: 已上传音色 URI 可用于 TTS 请求 失败返回 None
        """
        # 已有缓存时直接返回
        if self._voice_uploaded and self._voice_uri:
            return self._voice_uri

        with self._upload_lock:
            # 加锁后二次检查 避免重复上传
            if self._voice_uploaded and self._voice_uri:
                return self._voice_uri

            # 执行上传并记录状态
            self._voice_uri = self._upload_reference_audio()
            # 无论上传成功与否都标记已尝试 避免频繁重复请求
            self._voice_uploaded = True
            return self._voice_uri

    def reset_voice(self):
        """
        重置音色缓存状态

        常用于配置变更后强制重新上传
        """
        with self._upload_lock:
            # 清空已上传音色 URI
            self._voice_uri = None
            # 清空上传状态 下次调用重新上传
            self._voice_uploaded = False

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
        生成单段语音并保存到 cache 目录

        Args:
            text (str): 待合成文本

        Returns:
            Optional[str]: 生成文件绝对路径 失败返回 None
        """
        # 文本清洗与有效性检查
        clean_text = self._clean_text(text)
        if not self._is_valid_text(clean_text):
            logger.warning(f"无效文本: {text}")
            return None

        # 获取 API Key 为空则停止
        api_key = self._get_api_key()
        if not api_key:
            logger.warning("TTS API Key 为空")
            return None

        # 优先使用上传音色 失败回退默认音色
        voice = self._ensure_voice_uploaded() or f"{self.default_model}:claire"

        # 获取 cache 目录路径
        paths = get_paths()
        output_dir = paths.audio_cache_dir
        # 确保输出目录存在
        output_dir.mkdir(parents=True, exist_ok=True)

        try:
            url = f"{self.base_url}/audio/speech"
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            }
            # 构建请求体 限制输入长度避免超限
            payload = {
                "model": self.default_model,
                "input": clean_text[:700],
                "voice": voice,
                "response_format": "mp3",
                "speed": 1.0,
                "gain": 0.0,
            }

            # 请求云端合成接口
            response = requests.post(url, headers=headers, json=payload, timeout=30)
            if response.status_code != 200:
                logger.warning(f"❌ [API TTS] 生成失败: {response.status_code} - {response.text[:200]}")
                return None

            # 防止接口返回错误 JSON 造成伪音频保存
            content_type = response.headers.get("Content-Type", "")
            if "application/json" in content_type:
                logger.warning(f"❌ [API TTS] 返回 JSON 而非音频: {response.text[:200]}")
                return None

            # 生成文件名并写入磁盘
            filename = f"speech_{int(time.time() * 1000)}.mp3"
            output_path = output_dir / filename
            output_path.write_bytes(response.content)

            # 小文件通常表示失败响应 直接删除
            # 读取文件大小用于质量判断
            file_size = output_path.stat().st_size
            if file_size < 10:
                logger.warning(f"❌ [TTS] 音频文件太小 ({file_size} bytes) 删除")
                output_path.unlink(missing_ok=True)
                return None

            logger.info("✅ [TTS] 音频生成成功")
            logger.info(f"   📝 文本: {clean_text[:50]}...")
            logger.info(f"   📁 文件: {output_path}")
            logger.info(f"   📦 大小: {file_size} bytes")
            logger.info(f"   🌐 URL: /audio/cache/{filename}")
            return str(output_path)
        except Exception as e:
            logger.warning(f"❌ [API TTS] 异常: {e}")
            return None

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
            self._delete_files_later(valid_files, delay_seconds=CHUNK_DELETE_DELAY_SECONDS)
            return str(merged_path)
        except Exception as e:
            logger.warning(f"❌ [API TTS] 合并失败: {e}")
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
