from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional

from fastapi import HTTPException
from fastapi.responses import FileResponse

from api.routes.schemas.audio import AudioInfo
from config.paths import get_paths


class AudioService:
    """音频文件读取与缓存清理服务。"""

    def _serve_audio_file(self, file_path: Path, filename: str) -> FileResponse:
        if not file_path.exists():
            raise HTTPException(status_code=404, detail="未能找到音频文件")
        return FileResponse(path=str(file_path), media_type="audio/mpeg", filename=filename)

    def get_audio_cache(self, filename: str) -> FileResponse:
        paths = get_paths()
        return self._serve_audio_file(paths.audio_cache_dir / filename, filename)

    def get_audio_output(self, filename: str) -> FileResponse:
        paths = get_paths()
        return self._serve_audio_file(paths.audio_output_dir / filename, filename)

    def get_audio(self, filename: str) -> FileResponse:
        try:
            return self.get_audio_cache(filename)
        except HTTPException:
            return self.get_audio_output(filename)

    def list_audio_files(self) -> List[AudioInfo]:
        paths = get_paths()
        audio_files: List[AudioInfo] = []
        for audio_dir in [paths.audio_cache_dir, paths.audio_output_dir]:
            for file in audio_dir.glob("*.mp3"):
                audio_files.append(
                    AudioInfo(
                        filename=file.name,
                        url=f"/audio/{file.name}",
                        size=file.stat().st_size,
                    )
                )
        return audio_files

    def clear_audio_cache(self) -> Dict[str, str]:
        paths = get_paths()
        for file in paths.audio_cache_dir.glob("*.mp3"):
            file.unlink()
        return {"status": "cleared"}


_audio_service: Optional[AudioService] = None


def get_audio_service() -> AudioService:
    global _audio_service
    if _audio_service is None:
        _audio_service = AudioService()
    return _audio_service
