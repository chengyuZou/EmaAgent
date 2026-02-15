"""
NarrativeMemory - 记忆体模块
"""
from .core import NarrativeMemory
from .router import Router
from .rag_manager import RAGManager
from .exceptions import (
    NarrativeMemoryError,
    RouterError,
    RAGError,
    LLMError,
    EmbeddingError,
    ConfigError
)

__version__ = "0.2.0"

__all__ = [
    "NarrativeMemory",
    "Router",
    "RAGManager",
    "NarrativeMemoryError",
    "RouterError",
    "RAGError",
    "LLMError",
    "EmbeddingError",
    "ConfigError",
]
