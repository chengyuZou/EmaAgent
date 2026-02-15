"""
TTS 管理器 - 硅基流动语音合成

设计原则：
1. 不使用硬编码路径
2. 所有路径通过构造函数传入
3. 不直接依赖全局配置
"""
import asyncio
import re
import os
import queue
import threading
import time
import requests
import pygame
from pathlib import Path
from typing import Optional


# ✅ 修复后的分句正则：只在"真正的句子结束"处分割
SENTENCE_SPLIT_REGEX = re.compile(r'[。！？!?；;\n]')

# ✅ 清洗正则：匹配括号内容（动作描写）
ACTION_REMOVE_REGEX = re.compile(r'（[^）]*）|\([^)]*\)|\*[^*]*\*', flags=re.DOTALL)

# 默认参考音频文本（如果未提供）
DEFAULT_REFERENCE_TEXT = "我就是担心这种伤风败俗的东西如果被身心尚幼的小朋友们看到了会造成不好的影响,所以我想提前为小朋友们做好预防措施。"


class TTSManager:
    """
    TTS 管理器
    
    设计原则：
    - 所有路径通过构造函数传入
    - 不依赖全局配置
    """
    
    def __init__(
        self, 
        api_key: str, 
        output_dir: str,
        reference_audio_path: Optional[str] = None,
        reference_text: Optional[str] = None
    ):
        """
        初始化 TTS 管理器
        
        Args:
            api_key: 硅基流动 API Key
            output_dir: 音频输出目录
            reference_audio_path: 参考音频路径（可选）
            reference_text: 参考音频文本（可选）
        """
        self.api_key = api_key
        self.base_url = "https://api.siliconflow.cn/v1"
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        # 默认配置
        self.default_model = "FunAudioLLM/CosyVoice2-0.5B"
        self.default_voice: Optional[str] = None
        
        # ✅ 参考音频配置（通过参数传入，不使用硬编码）
        self._reference_audio_path = reference_audio_path
        self._reference_text = reference_text or DEFAULT_REFERENCE_TEXT
        self._voice_uploaded = False
        
        # ✅ 文本缓冲和计数器
        self.buffer = ""
        self.sentence_count = 0
        self.expected_index = 1  # ✅ 新增：期望播放的索引
        
        self.is_running = True
        self.play_queue: queue.PriorityQueue = queue.PriorityQueue()
        self.pending_audio: dict = {}  # ✅ 移到实例变量，方便重置
        
        # ✅ 生成任务追踪
        self._generation_threads: list = []
        self._generation_lock = threading.Lock()
        
        # 初始化 pygame mixer
        try:
            pygame.mixer.init(frequency=44100, size=-16, channels=2, buffer=512)
        except Exception as e:
            print(f"⚠️ Pygame 初始化失败: {e}")
        
        # 启动播放线程
        self.playback_thread = threading.Thread(target=self._playback_loop, daemon=True)
        self.playback_thread.start()

    def _ensure_voice_uploaded(self):
        """确保音色已上传（懒加载）"""
        if self._voice_uploaded:
            return
        
        if os.path.exists(self._reference_audio_path):
            self.default_voice = self._upload_reference_audio(
                audio_path=self._reference_audio_path,
                custom_name="ema_voice",
                text=self._reference_text,
            )
            if self.default_voice:
                self._voice_uploaded = True
        else:
            # 使用系统预置音色
            self.default_voice = f"{self.default_model}:claire"
            self._voice_uploaded = True
            print(f"⚠️ 参考音频不存在，使用预置音色: {self.default_voice}")

    def _upload_reference_audio(
        self, 
        audio_path: str, 
        custom_name: str, 
        text: str, 
        model: str = "FunAudioLLM/CosyVoice2-0.5B"
    ) -> Optional[str]:
        """上传参考音频，获取音色 ID"""
        url = f"{self.base_url}/uploads/audio/voice"
        headers = {"Authorization": f"Bearer {self.api_key}"}
        
        try:
            with open(audio_path, "rb") as f:
                files = {"file": f}
                data = {
                    "model": model,
                    "customName": custom_name,
                    "text": text
                }
                response = requests.post(url, headers=headers, files=files, data=data, timeout=30)
                
                if response.status_code == 200:
                    result = response.json()
                    # print(f"✅ 音色上传成功: {result['uri']}")
                    return result['uri']
                else:
                    print(f"❌ 音色上传失败: {response.text}")
                    return None
        except Exception as e:
            print(f"❌ 音色上传异常: {e}")
            return None

    def reset(self):
        """
        ✅ 重置状态 - 每次新对话前调用
        """
        # 等待当前所有生成任务完成
        self._wait_generation_complete()
        
        # 清空队列
        while not self.play_queue.empty():
            try:
                _, file_path = self.play_queue.get_nowait()
                self._safe_remove(file_path)
            except queue.Empty:
                break
        
        # 清空暂存区
        for file_path in self.pending_audio.values():
            self._safe_remove(file_path)
        self.pending_audio.clear()
        
        # 重置计数器
        self.buffer = ""
        self.sentence_count = 0
        self.expected_index = 1
        
    def _wait_generation_complete(self, timeout: float = 5.0):
        """等待所有生成线程完成"""
        with self._generation_lock:
            threads = self._generation_threads.copy()
        
        for t in threads:
            t.join(timeout=timeout)
        
        with self._generation_lock:
            self._generation_threads.clear()

    async def add_text_stream(self, text: str):
        """流式接收文本"""
        if not text:
            return
            
        self.buffer += text
        
        while True:
            match = SENTENCE_SPLIT_REGEX.search(self.buffer)
            if not match:
                break
            
            end_pos = match.end()
            raw_sentence = self.buffer[:end_pos]
            self.buffer = self.buffer[end_pos:]
            
            self._process_and_trigger(raw_sentence)

    async def flush(self):
        """处理剩余文本并等待播放完成"""
        if self.buffer.strip():
            self._process_and_trigger(self.buffer)
            self.buffer = ""
        
        # ✅ 等待所有音频播放完成
        await self._wait_playback_complete()

    async def _wait_playback_complete(self, timeout: float = 60.0):
        """等待所有音频播放完成"""
        start = time.time()
        
        # 先等待生成完成
        self._wait_generation_complete(timeout=10.0)
        
        # 再等待播放完成
        while time.time() - start < timeout:
            # 检查是否还有待播放的音频
            queue_empty = self.play_queue.empty()
            pending_empty = len(self.pending_audio) == 0
            music_idle = not pygame.mixer.music.get_busy()
            
            if queue_empty and pending_empty and music_idle:
                # 额外等待一小段时间确保最后一个音频播放完
                await asyncio.sleep(0.1)
                if not pygame.mixer.music.get_busy():
                    break
            
            await asyncio.sleep(0.1)

    def _process_and_trigger(self, raw_text: str):
        """清洗 -> 校验 -> 生成"""
        clean_text = self._clean_text(raw_text)
        
        if not self._is_valid_text(clean_text):
            return

        self._trigger_generation(clean_text)

    def _clean_text(self, text: str) -> str:
        """清洗文本：移除动作描写"""
        if not text:
            return ""
        
        # 1. 删除动作描写 （...） 和 (...)
        text = ACTION_REMOVE_REGEX.sub('', text)
        
        # 2. 删除省略号
        text = text.replace('...', '').replace('…', '')
        
        # 3. 去除首尾空白
        return text.strip()

    def _is_valid_text(self, text: str) -> bool:
        """检查文本是否包含有效语音内容"""
        check_text = re.sub(r'[^\w\u4e00-\u9fff]', '', text)
        return len(check_text) > 0

    def _trigger_generation(self, text: str):
        """触发音频生成"""
        self.sentence_count += 1
        current_index = self.sentence_count
        
        t = threading.Thread(
            target=self._generate_worker,
            args=(text, current_index),
            daemon=True
        )
        
        with self._generation_lock:
            self._generation_threads.append(t)
        
        t.start()

    def _generate_worker(self, text: str, index: int):
        """生成音频的工作线程"""
        # ✅ 确保音色已上传
        self._ensure_voice_uploaded()
        
        filename = f"speech_{int(time.time() * 1000)}_{index}.mp3"
        output_path = self.output_dir / filename
        
        success = self._request_api(text, str(output_path))
        
        if success and os.path.exists(output_path):
            self.play_queue.put((index, str(output_path)))
        else:
            # ✅ 生成失败时，放入一个标记让播放器跳过
            self.play_queue.put((index, None))
        
        # 清理线程引用
        with self._generation_lock:
            current_thread = threading.current_thread()
            if current_thread in self._generation_threads:
                self._generation_threads.remove(current_thread)

    def _request_api(self, text: str, output_path: str) -> bool:
        """API 请求"""
        try:
            url = f"{self.base_url}/audio/speech"
            headers = {
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json"
            }
            data = {
                "model": self.default_model,
                "input": text,
                "voice": self.default_voice,
                "response_format": "mp3",
                "speed": 1.0,
                "gain": 0.0
            }
            
            response = requests.post(url, headers=headers, json=data, stream=True, timeout=30)
            
            if response.status_code != 200:
                print(f"[TTS API Error] Status: {response.status_code}, Body: {response.text[:200]}")
                return False

            content_type = response.headers.get('Content-Type', '')
            if 'application/json' in content_type:
                print(f"[TTS API Error] Unexpected JSON response")
                return False

            with open(output_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=4096):
                    f.write(chunk)
            
            # 校验文件大小
            file_size = os.path.getsize(output_path)
            if file_size < 100:
                self._safe_remove(output_path)
                return False
                
            return True
            
        except Exception as e:
            print(f"[TTS Network Error] {e}")
            return False

    def _playback_loop(self):
        """播放循环"""
        while self.is_running:
            # 1. 检查暂存区是否有期望的音频
            if self.expected_index in self.pending_audio:
                file_path = self.pending_audio.pop(self.expected_index)
                if file_path:  # 非 None 才播放
                    self._play_file(file_path)
                self.expected_index += 1
                continue
            
            # 2. 从队列获取
            try:
                priority, file_path = self.play_queue.get(timeout=0.05)
                
                if priority == self.expected_index:
                    if file_path:  # 非 None 才播放
                        self._play_file(file_path)
                    self.expected_index += 1
                elif priority > self.expected_index:
                    # 还没轮到，暂存
                    self.pending_audio[priority] = file_path
                else:
                    # 过期的，丢弃
                    if file_path:
                        self._safe_remove(file_path)
                    
            except queue.Empty:
                continue
            except Exception as e:
                print(f"[Playback Error] {e}")

    def _play_file(self, file_path: str):
        """播放音频文件"""
        if not file_path or not os.path.exists(file_path):
            return

        try:
            pygame.mixer.music.load(file_path)
            pygame.mixer.music.play()
            
            # 等待播放完成
            while pygame.mixer.music.get_busy():
                pygame.time.Clock().tick(20)
            
            pygame.mixer.music.unload()
            
        except Exception as e:
            print(f"[Play Error] {e}")
        finally:
            self._safe_remove(file_path)

    def _safe_remove(self, file_path: str):
        """安全删除文件"""
        if not file_path:
            return
        try:
            if os.path.exists(file_path):
                time.sleep(0.01)
                os.remove(file_path)
        except Exception:
            pass

    def stop(self):
        """停止 TTS 服务"""
        self.is_running = False
        self._wait_generation_complete(timeout=2.0)
        try:
            pygame.mixer.quit()
        except Exception:
            pass


