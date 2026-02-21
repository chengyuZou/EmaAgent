import time
import requests
from typing import Optional

from config.paths import get_paths
from utils.logger import logger

from api.services.tts.base import BaseTTSProvider

# TODO 目前仅支持 vits 模型生成(主要是 B 站上有现成的魔裁角色 vits 模型), 后续可以根据需求添加更多模型的适配
class VitsSimpleApiTTSProvider(BaseTTSProvider):
    def __init__(self, config: dict):
        self.base_url = config.get("base_url", "http://localhost:23456/voice/vits")
        self.speaker = config.get("id", "0")
        self.default_language = config.get("language", "zh")
        self.default_speed = config.get("speed", 1.0)
        # 一般不需要 API Key

    def generate(self, text: str) -> Optional[str]:
        if not text:
            return None

        try:
            resp = requests.post(
                self.base_url, json={"text": text, "id": self.speaker}, timeout=30
            )
            if resp.status_code != 200:
                logger.warning(
                    f"❌ [VitsSimpleApi TTS] TTS 生成失败: {resp.status_code} - {resp.text[:200]}"
                )
                return None

            # 防止接口返回错误 JSON 造成伪音频保存
            content_type = resp.headers.get("Content-Type", "")
            if "application/json" in content_type:
                logger.warning(
                    f"❌ [VitsSimpleApi TTS] 返回 JSON 而非音频: {resp.text[:200]}"
                )
                return None

            paths = get_paths()
            out_dir = paths.audio_cache_dir
            filename = f"speech_{int(time.time()*1000)}.wav" # vits_simple_api 默认返回 wav 格式
            output_path = out_dir / filename
            output_path.write_bytes(resp.content)

            # 小文件通常表示失败响应 直接删除
            # 读取文件大小用于质量判断
            file_size = output_path.stat().st_size
            if file_size < 10:
                logger.warning(f"❌ [VitsSimpleApi TTS] 音频文件太小 ({file_size} bytes) 删除")
                output_path.unlink()
                return None

            logger.info("✅ [VitsSimpleApi TTS] 音频生成成功")
            logger.info(
                f"   📝 文本: {text[:50]}...\n   📁 文件: {output_path}\n   📦 大小: {file_size} bytes\n   🌐 URL: /audio/cache/{filename}"
            )
            return str(output_path)
        except Exception as e:
            logger.warning(f"❌ [VitsSimpleApi TTS] 异常: {e}")
            return None
