# Providers

[中文](README-zh.md)

`@ema-agent/providers` stores model suppliers, credentials, protocol addresses, model settings, and the model selected for each business module. It resolves a configured capability into a connection that an API package can use.

## Using a connection

The host supplies a migrated profile `Database` from `@ema-agent/storage`.

```ts
import { Providers } from '@ema-agent/providers';

const providers = new Providers(profileDb);
providers.create({
  id: 'local-models',
  name: 'Local models',
  authType: 'none',
  capability: {
    capability: 'embed',
    protocol: 'openai-embed',
    baseUrl: 'http://127.0.0.1:8080/v1',
  },
});

const connection = providers.resolveConnection('local-models', 'embed');
// { providerId, protocol, baseUrl, apiKey? }
```

The caller passes this connection and a model ID to `createEmbedCall`, `createRerankCall`, `createTTSCall`, `createSTTCall`, or the LLM/Vision entry point. Each capability selects its own protocol and address. All capabilities of one provider share a credential.

Browser code imports runtime constants from `@ema-agent/providers/types`. This entry only has a type-only Storage dependency. The main entry constructs database repositories and is intended for the Server.

## Saved data and public operations

| Entry | Operations | Saved data |
| --- | --- | --- |
| `Providers` | Create, update, delete, list, resolve a connection, record health | `providers`, `provider_capabilities`, `provider_protocols`, `provider_health` |
| `ProviderModels` | Save manual models, enable/disable, delete, sync the catalog | `provider_models` |
| `ModelBindings` | Set, get, list, delete a module's selected model | `model_bindings` |
| `ModelsDevCatalog` | Parse and look up catalog entries by supplier and model | In-memory catalog loaded from a JSON file |

Storage repositories read and write `profile.db`. Built-in provider entries are inserted by Storage migrations and then use the same operations as user-created entries. Credentials are stored as plain text. The Server's provider list returns `hasKey`, while provider details include the full `keyValue` for editing.

A model is addressed by `(providerId, capability, modelId)`. LLM and Vision models have context-window and capability settings, Embedding models have a dimension, and Rerank models have an optional `maxChunks`. Unknown optional model capabilities remain `null` in saved models rather than becoming `false`.

`create()` configures one capability at a time. If the ID already exists, it adds a missing capability and can update the shared credential; it keeps the existing name and authentication mode. Creating the same ID and capability twice fails. A new capability requires an explicit protocol and `baseUrl`.

An undefined `activeProtocol` means the capability is disabled, with its saved protocols retained. Removing the active protocol selects the first remaining protocol; removing every protocol fails. For updates, `key: undefined` keeps the credential and `key: null` clears it.

`resolveConnection()` requires an active protocol with an address, and a credential for `bearer` authentication. It returns configuration, not the result of a network test.

Provider `id`, display `name`, and capability `modelsDevId` have different uses. IDs identify saved references, names label the UI, and `modelsDevId` selects an external catalog. Built-in domestic entries use `siliconflow-cn` / `SiliconFlow-CN` and `moonshotai-cn` / `Moonshot Kimi-CN`; their catalog IDs match their provider IDs. Their icon keys remain `siliconflow` and `moonshot`. These entries are seeded directly by Storage initialization.

DeepSeek is available in both LLM and Vision, with the `deepseek` catalog association. Both capabilities default to Chat Completions and also configure an Anthropic-compatible endpoint. Vision catalog imports include only image-input models; initialization does not select, enable or bind a model.

LLM and Vision creation accepts an optional `modelsDevId`. Updates omit it to keep the association or pass `null` to clear it. Clearing or changing the association does not delete existing models or bindings, and does not change the API address. Without an association, models are entered manually.

## Models and bindings

Manual models use `source: 'user'` and start enabled. Saving them again updates their settings and keeps their enabled state. Catalog models use `source: 'dev'`; catalog sync updates their settings. Both kinds can be enabled, disabled, or deleted.

`ModelBindings.set()` derives the capability from the module name and accepts an enabled model in that capability. The Server binding route also resolves the connection before saving. The `/available/:capability` route lists enabled models whose provider connection can be resolved.

Deleting a provider, disabling a capability, or disabling/deleting a model checks saved module bindings first. A conflict raises `ProviderError` with `conflicts`, which the settings page uses to ask for a different binding. This check concerns saved module bindings, not Session model selections.

Health is saved separately for each `(providerId, capability)`. The Server runs the network test and supplies its result to `recordHealth()`.

Changing the shared credential, authentication mode, active protocol, or active address clears the affected saved health in the configuration transaction. Renaming the provider or changing its catalog association does not invalidate the connection result.

Without an explicit model ID, Server Ping uses the first enabled model in list order, then the first model if all are disabled. An empty LLM/Vision pool can fall back to the first catalog model; other empty pools require a manual model. Vision Ping sends text only: a successful Ping does not prove image support or a valid Vision binding.

## Catalog refresh and window updates

`loadModelsDevCatalog(filePath)` reads the supplied cache file. A missing or unreadable file produces an empty catalog; saved database models remain available. Catalog lookups use `modelsDevId` and model ID, since suppliers can describe the same model differently.

`refreshModelsDevCatalog(catalog, filePath)` downloads the full catalog with a 30-second timeout, rejects responses larger than 8 MiB after reading them, and rejects a parsed catalog with no usable entries. It replaces a changed cache file through a temporary file, then updates the existing catalog object. A failed download, parse, or file save leaves the current catalog in place.

The Server coordinates refresh requests in this order:

```text
Settings requests a provider's LLM or Vision model refresh
  -> Server shares any download already in progress
  -> refreshModelsDevCatalog saves JSON and updates the shared catalog
  -> syncDevModels(providerId, capability) saves that scope in one SQL transaction
  -> Server emits provider_models_changed
  -> Desktop reads the model list again
```

Sync creates new catalog models disabled, preserves existing enabled states, leaves manual models unchanged, skips entries without a valid context window, and does not delete models missing from the new catalog. Embedding, Rerank, TTS, and STT models are entered manually.

An absent catalog association or unknown catalog provider produces a configuration error with a readable message. An existing provider with no matching Vision entries is an empty result, not a missing-model error. Refresh uses models.dev, not the supplier's mixed-capability `/models` endpoint. Desktop keeps existing cards mounted during background list reloads; the initial load alone replaces the grid with a loading indicator.

A SQL sync failure rolls back that scope's database writes. An already saved catalog file remains available for a retry. Catalog refresh does not select a different bound model.

Provider operations do not publish window events themselves. The Server emits `ProviderEvent` after saving: `provider_config_changed`, `provider_models_changed`, `model_bindings_changed`, or `provider_health_changed`.

## Reading and checking the code

Start with [types.ts](types.ts) for capability/protocol names and `ProviderConnection`, then [providers.ts](providers.ts), [models.ts](models.ts), and [modelBindings.ts](modelBindings.ts) for the saved operations. [catalog/modelsDevCatalog.ts](catalog/modelsDevCatalog.ts) contains file refresh and parsing. Server [composition/providers.ts](../../apps/server/src/composition/providers.ts) coordinates downloads, while [routes/providers](../../apps/server/src/routes/providers) handles HTTP responses and notifications.

```sh
pnpm --filter @ema-agent/providers test
pnpm --filter @ema-agent/server exec vitest run tests/providerCatalogRefresh.test.ts
```

Package tests exercise real profile-database rows, binding conflicts, model sync, and catalog parsing. The Server test checks refresh request handling and notifications with a local test setup.
