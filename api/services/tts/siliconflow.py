import os
import time
import requests
from pathlib import Path
from typing import Optional
from threading import Lock

from api.services.tts.base import BaseTTSProvider
from config.paths import get_paths
from utils.logger import logger


class SiliconflowTTSProvider(BaseTTSProvider):
    def __init__(self, config: dict):
        self.base_url = config.get("base_url", "https://api.siliconflow.cn/v1")
        self.api_key = config.get("api_key", "")
        self.default_model = config.get("model", "FunAudioLLM/CosyVoice2-0.5B")
        # 上传后返回的音色 URI 缓存
        self._voice_uri = None
        # 标记是否已尝试上传过音色
        self._voice_uploaded = False
        # 上传过程互斥锁 防止并发重复上传
        self._upload_lock = Lock()

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
        paths = get_paths()
        config = paths.load_config()
        return config.get("tts", {}).get(
            "reference_text",
            "我就是担心这种伤风败俗的东西如果被身心尚幼的小朋友们看到了 会造成不好的影响 所以想提前做好预防措施",
        )

    def _upload_reference_audio(self) -> Optional[str]:
        """
        上传参考音频并返回音色 URI
        """
        # 未配置 Key 直接返回
        if not self.api_key:
            logger.warning("[siliconflow API TTS] API Key 未配置")
            return None

        # 获取参考音频文件路径
        ref_audio_path = self._get_reference_audio_path()
        # 无参考音频时回退默认音色
        if not ref_audio_path:
            logger.warning("[siliconflow API TTS] 未找到参考音频 使用默认音色")
            return f"{self.default_model}:claire"

        # 构建上传接口地址与请求头
        url = f"{self.base_url}/uploads/audio/voice"
        headers = {"Authorization": f"Bearer {self.api_key}"}

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
                response = requests.post(
                    url, headers=headers, files=files, data=data, timeout=30
                )

            # 成功时读取返回 URI
            if response.status_code == 200:
                result = response.json()
                voice_uri = result.get("uri")
                logger.info(f"✅ [siliconflow API TTS] 音色上传成功: {voice_uri}")
                return voice_uri

            # 失败时打印状态码与响应
            logger.warning(
                f"❌ [siliconflow API TTS] 音色上传失败: {response.status_code} - {response.text}"
            )
            return None
        except Exception as e:
            logger.warning(f"❌ [siliconflow API TTS] 音色上传异常: {e}")
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

    def reset(self):
        """
        重置音色缓存状态

        常用于配置变更后强制重新上传
        """
        with self._upload_lock:
            # 清空已上传音色 URI
            self._voice_uri = None
            # 清空上传状态 下次调用重新上传
            self._voice_uploaded = False

    def generate(self, text: str) -> Optional[str]:
        """
        生成单段语音并保存到 cache 目录

        Args:
            text (str): 待合成文本

        Returns:
            Optional[str]: 生成文件绝对路径 失败返回 None
        """
        # 获取 API Key 为空则停止
        if not self.api_key:
            logger.warning("[siliconflow API TTS] API Key 为空")
            return None

        # 优先使用上传音色 失败回退默认音色
        voice = self._ensure_voice_uploaded() or f"{self.default_model}:claire"

        try:
            url = f"{self.base_url}/audio/speech"
            headers = {
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            }
            # 构建请求体 限制输入长度避免超限
            payload = {
                "model": self.default_model,
                "input": text[:700],
                "voice": voice,
                "response_format": "mp3",
                "speed": 1.0, # TODO 后续可以开放配置或参数化
                "gain": 0.0, # TODO 后续可以开放配置或参数化
            }
            
            # 请求云端合成接口
            resp = requests.post(url, headers=headers, json=payload, timeout=30)
            if resp.status_code != 200:
                logger.warning(
                    f"❌ [siliconflow API TTS] TTS 生成失败: {resp.status_code} - {resp.text[:200]}"
                )
                return None
            
            # 防止接口返回错误 JSON 造成伪音频保存
            content_type = resp.headers.get("Content-Type", "")
            if "application/json" in content_type:
                logger.warning(
                    f"❌ [siliconflow API TTS] 返回 JSON 而非音频: {resp.text[:200]}"
                )
                return None

            # 生成文件名并写入磁盘, tts_service 已保证创建缓存目录, 此处直接使用即可
            paths = get_paths()
            out_dir = paths.audio_cache_dir
            filename = f"speech_{int(time.time()*1000)}.mp3"
            output_path = out_dir / filename
            output_path.write_bytes(resp.content)

            # 小文件通常表示失败响应 直接删除
            # 读取文件大小用于质量判断
            file_size = output_path.stat().st_size
            if file_size < 10:
                logger.warning(f"❌ [siliconflow API TTS] 音频文件太小 ({file_size} bytes) 删除")
                output_path.unlink()
                return None

            logger.info("✅ [siliconflow API TTS] 音频生成成功")
            logger.info(
                f"   📝 文本: {text[:50]}...\n   📁 文件: {output_path}\n   📦 大小: {file_size} bytes\n   🌐 URL: /audio/cache/{filename}"
            )
            return str(output_path)
        except Exception as e:
            logger.warning(f"❌ [siliconflow API TTS] TTS 异常: {e}")
            return None
