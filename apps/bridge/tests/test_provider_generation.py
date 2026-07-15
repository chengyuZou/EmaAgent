from __future__ import annotations

import unittest
from unittest.mock import patch

from bridge.config import ConfigureRequest, EmbedCfg, LlmCfg
from bridge.routes import internal
from bridge.state import state


class _OldManager:
    def __init__(self) -> None:
        self.finalized = False

    async def finalize(self) -> None:
        self.finalized = True


class _NewManager:
    last: _NewManager | None = None
    fail_initialize = False

    def __init__(self, snapshot, _data_dir: str) -> None:
        self.snapshot = snapshot
        self.initialized = False
        self.finalized = False
        _NewManager.last = self

    async def initialize(self) -> None:
        if self.fail_initialize:
            raise RuntimeError("initialize failed")
        self.initialized = True

    async def finalize(self) -> None:
        self.finalized = True


class ProviderGenerationTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        state.embed_api_key = "old-embed-key"
        state.embed_base_url = "https://old-embed.test"
        state.embed_model = "old-embed-model"
        state.embed_dim = 768
        state.llm_api_key = "old-llm-key"
        state.llm_base_url = "https://old-llm.test"
        state.llm_model = "old-llm-model"
        state.narrative_manager = None
        state.narrative_router = None
        _NewManager.last = None
        _NewManager.fail_initialize = False

    async def test_null_snapshot_clears_credentials_and_finalizes_old_manager(self) -> None:
        old_manager = _OldManager()
        state.narrative_manager = old_manager
        state.narrative_router = object()

        await internal.configure(
            ConfigureRequest(embed=None, llm=None),
        )

        self.assertEqual(state.embed_api_key, "")
        self.assertEqual(state.llm_api_key, "")
        self.assertIsNone(state.narrative_manager)
        self.assertIsNone(state.narrative_router)
        self.assertTrue(old_manager.finalized)

    async def test_failed_next_generation_keeps_old_generation_intact(self) -> None:
        old_manager = _OldManager()
        old_router = object()
        state.narrative_manager = old_manager
        state.narrative_router = old_router
        _NewManager.fail_initialize = True
        request = ConfigureRequest(
            embed=EmbedCfg(
                api_key="new-embed-key",
                base_url="https://new-embed.test",
                model="new-embed-model",
                dim=1024,
            ),
            llm=LlmCfg(
                api_key="new-llm-key",
                base_url="https://new-llm.test",
                model="new-llm-model",
            ),
        )

        with patch.object(internal, "NarrativeManager", _NewManager):
            with self.assertRaisesRegex(RuntimeError, "initialize failed"):
                await internal.configure(request)

        self.assertEqual(state.embed_api_key, "old-embed-key")
        self.assertEqual(state.llm_api_key, "old-llm-key")
        self.assertIs(state.narrative_manager, old_manager)
        self.assertIs(state.narrative_router, old_router)
        self.assertFalse(old_manager.finalized)

    async def test_successful_generation_publishes_after_initialization(self) -> None:
        old_manager = _OldManager()
        state.narrative_manager = old_manager
        request = ConfigureRequest(
            embed=EmbedCfg(
                api_key="new-embed-key",
                base_url="https://new-embed.test",
                model="new-embed-model",
                dim=1024,
            ),
            llm=LlmCfg(
                api_key="new-llm-key",
                base_url="https://new-llm.test",
                model="new-llm-model",
            ),
        )

        with (
            patch.object(internal, "NarrativeManager", _NewManager),
            patch.object(internal, "NarrativeRouter", lambda snapshot: ("router", snapshot)),
        ):
            await internal.configure(request)

        self.assertIsNotNone(_NewManager.last)
        self.assertTrue(_NewManager.last.initialized)
        self.assertIs(state.narrative_manager, _NewManager.last)
        self.assertEqual(state.llm_api_key, "new-llm-key")
        self.assertEqual(state.embed_api_key, "new-embed-key")
        self.assertTrue(old_manager.finalized)


if __name__ == "__main__":
    unittest.main()
