from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from bridge.narrative.manager import NarrativeManager
    from bridge.narrative.router import NarrativeRouter


@dataclass
class BridgeState:
    """
    Runtime state for the bridge process.

    Populated by POST /internal/configure after apps/localHost starts.
    All fields are empty until configured — narrative routes return 503 when unready.
    """

    # Raw embed config — stored so LightRAG adapters can build their own client.
    embed_api_key:  str = field(default="")
    embed_base_url: str = field(default="")
    embed_model:    str = field(default="")
    embed_dim:      int = field(default=1024)

    # LLM used by LightRAG for entity extraction + query routing.
    llm_api_key:  str = field(default="")
    llm_base_url: str = field(default="")
    llm_model:    str = field(default="")

    # Built by /internal/configure once both embed + llm are ready.
    narrative_manager: NarrativeManager | None = field(default=None)
    narrative_router:  NarrativeRouter  | None = field(default=None)

    @property
    def embed_ready(self) -> bool:
        return bool(self.embed_api_key and self.embed_model)

    @property
    def llm_ready(self) -> bool:
        return bool(self.llm_api_key and self.llm_model)

    @property
    def narrative_ready(self) -> bool:
        return self.narrative_manager is not None and self.narrative_router is not None


# Module-level singleton — imported by all route modules.
state = BridgeState()
