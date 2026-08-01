class NarrativeNotConfiguredError(RuntimeError):
    """Narrative 尚未收到完整的模型配置。"""


class NarrativeContentError(RuntimeError):
    """Narrative 剧情目录缺失、结构错误或不可写。"""
