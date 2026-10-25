# 0.1.0-beta.1

[中文](./README-zh.md)

Status: Draft, not published.

## Narrative adjustments

Experiments informed changes to Narrative query preparation and retrieval parameters:

- Timeline selection and keyword extraction now run as two independent, concurrent requests. Retrieval and Rerank use the incoming query without generating per-timeline subqueries.
- Direct passage-vector retrieval in naive/mix keeps up to 100 candidates. Each selected timeline sends at most 125 merged candidates to Rerank and requests up to 30 results.
- Graph description length no longer excludes associated source passages. Final evidence keeps the existing 32000-character budget, divided among selected timelines.

The limits are defined in Narrative. The shared Rerank interface and its topK parameter remain unchanged. These adjustments do not guarantee complete story evidence.

## History scrolling

- History compensates measured row heights while scrolling upward and preserves the reading anchor when loading older messages. Returning to the actual end resumes following appended messages. Source and isolated browser checks passed; installed-build acceptance remains pending. [Bug record](./logs/en/historyScrolling.md).

## Live2D compatibility

- Upgraded Cubism Core to `06.00.0001` and adapted the renderer to Pixi 8 and WebGL2. Fixed model import/preview failures and resource cleanup. Ema, Hiyori, Haru, Wanko and Ren passed browser regression under the release CSP; installed-build acceptance remains pending.
- Expressions now apply after automatic blinking, and model covers render at 3072x4096. These follow-up changes await manual application checks.
- Live2D emotion and motion mappings are stored per model in the Profile database. Model imports and exports transfer resource files, with mappings configured in Settings.

## Upload limits

- Increased ordinary JSON and Turn request-body limits to 128 MiB, and audio and wallpaper uploads to 256 MiB. Live2D covers accept PNG data up to 100 MiB with a separate allowance for base64 transport.

Module details: [Narrative](../../../src/narrative/README.md). Earlier records: [Alpha](../v0.1.0-alpha.1/README.md).
