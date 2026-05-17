from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from bridge.embed.protocols import EmbedProvider, RerankProvider
    from bridge.narrative.manager import NarrativeManager
    from bridge.narrative.router import NarrativeRouter


@dataclass
class BridgeState:
    """
    Runtime state for the bridge process.

    Populated by POST /internal/configure after apps/core starts.
    All fields are None until configured — routes return 503 when unconfigured.
    """

    embedder: EmbedProvider | None = field(default=None)
    reranker: RerankProvider | None = field(default=None)

    # LLM client used by LightRAG for entity extraction + query routing.
    # Shares the same openai-compat provider as apps/core's chat LLM.
    llm_api_key: str = field(default="")
    llm_base_url: str = field(default="")
    llm_model: str = field(default="")

    # Built by /internal/configure once both embed + llm are ready.
    narrative_manager: NarrativeManager | None = field(default=None)
    narrative_router: NarrativeRouter | None = field(default=None)

    @property
    def embed_ready(self) -> bool:
        return self.embedder is not None

    @property
    def rerank_ready(self) -> bool:
        return self.reranker is not None

    @property
    def llm_ready(self) -> bool:
        return bool(self.llm_api_key and self.llm_model)

    @property
    def narrative_ready(self) -> bool:
        return self.narrative_manager is not None and self.narrative_router is not None


# Module-level singleton — imported by all route modules.
state = BridgeState()
