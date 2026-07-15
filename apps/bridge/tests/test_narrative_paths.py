from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from bridge.narrative.manager import (
    TIMELINES,
    resolve_narrative_root,
    validate_narrative_root,
)


class NarrativePathsTest(unittest.TestCase):
    def test_default_root_does_not_depend_on_current_working_directory(self) -> None:
        expected = Path(__file__).resolve().parents[1] / "data" / "narrative"
        original_cwd = Path.cwd()
        with tempfile.TemporaryDirectory() as other_cwd:
            try:
                os.chdir(other_cwd)
                actual = resolve_narrative_root({})
            finally:
                os.chdir(original_cwd)

        self.assertEqual(actual, expected.resolve())

    def test_explicit_absolute_root_is_supported(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(
                resolve_narrative_root({"EMA_NARRATIVE_DIR": root}),
                Path(root).resolve(),
            )

    def test_relative_override_is_rejected(self) -> None:
        with self.assertRaises(RuntimeError):
            resolve_narrative_root({"EMA_NARRATIVE_DIR": "./data/narrative"})

    def test_missing_timeline_is_rejected_without_creating_empty_world(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            for timeline in TIMELINES[:-1]:
                (root_path / timeline).mkdir()

            with self.assertRaisesRegex(RuntimeError, TIMELINES[-1]):
                validate_narrative_root(root_path)
            self.assertFalse((root_path / TIMELINES[-1]).exists())

    def test_complete_writable_root_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            for timeline in TIMELINES:
                (root_path / timeline).mkdir()

            validate_narrative_root(root_path)
            for timeline in TIMELINES:
                self.assertEqual(list((root_path / timeline).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
