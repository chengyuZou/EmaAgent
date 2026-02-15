"""
自定义异常模块
"""

class NarrativeMemoryError(Exception):
    """记忆体基础异常"""
    pass

class RouterError(NarrativeMemoryError):
    """路由器异常"""
    pass

class RAGError(NarrativeMemoryError):
    """RAG 异常"""
    pass

class LLMError(NarrativeMemoryError):
    """LLM 调用异常"""
    pass

class EmbeddingError(NarrativeMemoryError):
    """Embedding 异常"""
    pass

class ConfigError(NarrativeMemoryError):
    """配置异常"""
    pass