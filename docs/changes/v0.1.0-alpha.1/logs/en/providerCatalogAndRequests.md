# Provider catalogs, settings feedback and request budgets

[中文](../zh/providerCatalogAndRequests.md)

## Status

Source fixes and automated regression checks passed on 2026-10-20, and the user confirmed the Provider workflows passed in the application. The consolidated initialization SQL and new DeepSeek Vision preset still need fresh-start acceptance. Consolidated installed-build acceptance remains separate. Automated checks use in-memory databases and simulated HTTP responses without calling paid models.

## Confirmed causes

- Enabling or disabling a model triggered a list reload that replaced all cards with a loading indicator. Saved failed health was initially displayed as partial validation instead of its actual failure.
- Domestic SiliconFlow and Moonshot endpoints were seeded with international catalog associations. A provider's catalog ID determines model IDs and parameters; using an international directory can therefore import IDs unavailable at the domestic endpoint.
- Provider creation accepted `modelsDevId` at the route but omitted it when saving a new provider. The creation UI also lacked the field.
- Default Ping selected the first model row even if a later model was enabled.
- Narrative passed the catalog's maximum output capacity as the request budget. The installed Anthropic SDK rejected a non-streaming 128000-Token request before HTTP, producing the streaming-required error. This was not an observed ten-minute wait.

The historical image errors are not all one defect. A missing model ID, an upstream `403 Model disabled`, and a rejected thinking parameter require different checks. A later successful image request did not establish that every earlier configuration was valid.

## Changes

- Profile and Data each use a single `001_initial.sql`, with database version 1. Profile directly seeds `siliconflow-cn` and `moonshotai-cn`, displayed as `SiliconFlow-CN` and `Moonshot Kimi-CN`, with matching catalog IDs. The temporary domestic-ID migrations and cross-database migration argument are removed. This Alpha baseline requires fresh application data; it does not migrate earlier development databases or copy their credentials and conversations.
- The existing DeepSeek Provider also has Vision, using the `deepseek` catalog ID, Chat Completions by default and an optional Anthropic-compatible endpoint. Catalog refresh only imports image-input models for Vision. No model or binding is preselected.
- LLM/Vision creation and advanced settings accept an optional models.dev ID. Clearing it does not delete existing models or bindings. Refresh continues to use models.dev, not a supplier `/models` endpoint. Missing/unknown associations produce readable configuration errors. Old imported rows are not automatically removed.
- Ping uses the first enabled model, or the first row when all are disabled. Its existing catalog fallback for an empty LLM/Vision pool remains. Vision Ping is explicitly described as a text connectivity check.
- Background model reloads retain cards. Saved failed health is displayed and follows updated provider details. Credential or active-connection changes clear old saved health in the same transaction.
- The public LLM request retains `thinking`. A private function inside the Chat Completions protocol derives SiliconFlow's `enable_thinking` only for the official SiliconFlow hosts, removes the generic `thinking` from that outgoing request, and limits effort mapping to documented model IDs. The wire field is not added to public types, settings or SQL. Other hosts retain the existing mapping. References: [SiliconFlow](https://docs.siliconflow.cn/docs/api/chat-completions-post), [DeepSeek](https://api-docs.deepseek.com/guides/thinking_mode/).
- Narrative retains native non-streaming completion with a fixed `maxOutputTokens: 8192`. An output-limit stop is still treated as incomplete routing, not a usable partial plan.

## Verification and remaining checks

Storage tests exercise fresh independent initialization, domestic IDs and endpoints, DeepSeek Vision protocols, foreign keys, repeated initialization and rejection of newer databases. Provider tests cover catalog selection, image-input filtering, creation, clearing, retained rows and health invalidation. Server tests cover default/explicit Ping selection, catalog refresh and the real Narrative-to-Anthropic SDK request, including `stream: false`, `max_tokens: 8192` and saved usage. LLM and Vision tests inspect outgoing HTTP bodies and preserved errors. Desktop DOM tests cover retained cards, saved failure updates, creation fields and clearing an association.

The Storage, Providers, LLM and Vision suites passed, as did the three targeted Server test files and five Provider component cases. Storage, Providers, LLM and Server compilation and Desktop type checking passed. The separate Anthropic-budget diagnostic test was removed after the Narrative integration test covered the actual caller.

Before resetting existing application data, stop Ema and preserve any data that must remain recoverable. A fresh start needs credentials, model selections and bindings to be configured again. Check the domestic entries and DeepSeek Vision preset after initialization. Real model requests may incur charges. The original SiliconFlow timeout and all historical image configuration combinations were not individually reproduced by mocked HTTP tests; user workflow acceptance does not establish every upstream configuration as valid.
